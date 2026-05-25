# Agent CLI Providers Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Evolve Codex Telegram Bridge from a Codex-only Telegram bridge into a provider-based agent bridge that can run Codex CLI by default and later support Claude CLI and Antigravity CLI without breaking existing users.

**Architecture:** Keep Telegram, workspace allowlisting, audit logging, command buttons, verify runners, attachment handling, and session orchestration in the existing bridge. Move CLI-specific behavior behind an agent provider interface. Codex becomes the first concrete provider and remains the default. Claude and Antigravity providers are added incrementally, with capability flags for resume, JSON streaming, images, sandbox enforcement, and command-event formatting.

**Tech Stack:** Node.js 12 CommonJS, Telegram Bot HTTP API, built-in `child_process`, existing JSON state files, existing `test/run.js` harness, Codex CLI as the default provider, optional Claude CLI and Antigravity CLI binaries installed on the host.

**Non-Goals:** Do not rewrite the Telegram command system, change the allowlist security model, require a database, or remove existing `CODEX_*` environment variables. Do not claim full Claude or Antigravity parity until their real CLI syntax and output format are verified on the deployment host.

---

### Task 1: Audit Current Codex Coupling

**Files:**
- Inspect: `src/codex.js`
- Inspect: `src/session-manager.js`
- Inspect: `src/config.js`
- Inspect: `src/commands.js`
- Inspect: `src/bot-commands.js`
- Inspect: `src/state-store.js`
- Inspect: `README.md`
- Inspect: `.env.example`
- Inspect: `.env.advanced.example`
- Test: `test/run.js`

- [ ] **Step 1: List CLI-specific responsibilities**

Document every behavior that currently assumes Codex CLI:
- Process binary selection through `CODEX_BIN`.
- Argument shape: `exec`, `resume`, `--json`, `--color never`, `--sandbox`, `--cd`, `--image`, `-`.
- JSON event format: `thread.started`, `turn.started`, `item.started`, `item.completed`, `agent_message`, `command_execution`.
- Thread/session extraction through `thread_id`.
- Resume behavior through `codex exec resume --last --json` or a saved thread ID.
- User-facing command names and labels containing “Codex”.
- State field names such as `codexThreadId`.
- Audit event names such as `codex.started` and `codex.finished`.

- [ ] **Step 2: Identify backward-compatibility requirements**

Preserve these behaviors for existing deployments:
- `CODEX_BIN` still works when no new provider settings are configured.
- `CODEX_EXTRA_ARGS` still appends arguments to Codex runs.
- `CODEX_RESUME_LAST=true` still resumes Codex sessions.
- `/codex-last`, `/codex_last`, `/fix-last`, and `/fix_last` keep working.
- Existing state files with `codexThreadId` are still readable.
- Existing docs and examples remain valid for Codex users.

- [ ] **Step 3: Add notes to the plan before coding**

Record unresolved provider-specific facts that must be checked before full implementation:
- Claude CLI command syntax for non-interactive prompt execution.
- Claude CLI support for structured JSON streaming.
- Claude CLI support for cwd, image attachments, resume/session IDs, and sandbox-like controls.
- Antigravity CLI command syntax and output format.
- Whether Antigravity supports non-interactive stdin prompts.

---

### Task 2: Introduce an Agent Provider Interface

**Files:**
- Create: `src/agent-providers/index.js`
- Create: `src/agent-providers/codex.js`
- Create: `src/agent-providers/types.js` if useful, or keep JSDoc typedefs inline for Node 12
- Modify: `src/session-manager.js`
- Modify: `src/config.js`
- Test: `test/run.js`

- [ ] **Step 1: Define the provider contract**

Create a small CommonJS interface by convention:

```js
const provider = {
  id: 'codex',
  displayName: 'Codex',
  defaultBin: 'codex',
  supportsJsonEvents: true,
  supportsResume: true,
  supportsImages: true,
  supportsSandboxMode: true,
  buildArgs(options) {},
  formatJsonLine(line, options) {},
  extractEventInfo(line) {},
};
```

- [ ] **Step 2: Standardize run options**

Use provider-neutral option names while accepting legacy Codex names during migration:

```js
{
  provider,
  agentBin,
  workspace,
  sandboxMode,
  extraArgs,
  skipGitRepoCheck,
  resumeLast,
  resumeSessionId,
  imagePaths,
  showCommandEvents,
}
```

- [ ] **Step 3: Standardize extracted event info**

All providers should return the same shape even if fields are unavailable:

```js
{
  threadId: '',
  assistantText: '',
  commandStarted: null,
  commandCompleted: null,
  rawType: '',
}
```

- [ ] **Step 4: Add provider lookup**

Implement a resolver:

```js
function getAgentProvider(providerId) {
  if (!providerId || providerId === 'codex') return codexProvider;
  if (providerId === 'claude') return claudeProvider;
  if (providerId === 'antigravity') return antigravityProvider;
  throw new Error(`Unsupported AGENT_PROVIDER: ${providerId}`);
}
```

Start with only Codex registered if Claude and Antigravity adapters are not ready in this task.

---

### Task 3: Refactor Codex Into the First Provider

**Files:**
- Modify: `src/codex.js`
- Create or modify: `src/agent-providers/codex.js`
- Modify: `src/session-manager.js`
- Test: `test/run.js`

- [ ] **Step 1: Move Codex argument building into the provider**

Keep current output exactly equivalent:

```js
['exec', '--json', '--color', 'never', '--sandbox', sandboxMode, '--cd', workspace, '-']
```

Resume variants must remain equivalent:

```js
['exec', 'resume', '--json', resumeSessionId, '-']
['exec', 'resume', '--last', '--json', '-']
```

- [ ] **Step 2: Move Codex JSON line formatting into the provider**

Keep current behavior for:
- Suppressing `thread.started`, `turn.started`, and `turn.completed`.
- Suppressing non-command `item.started` and `item.updated` events.
- Rendering agent messages directly.
- Rendering command events only when `showCommandEvents` is enabled.
- Falling back to `msg`, `message`, `delta`, `type`, or raw text.

- [ ] **Step 3: Keep `src/codex.js` as a compatibility facade**

Avoid a large breaking rename in one step. Let `src/codex.js` export the old function names, delegating to the Codex provider:

```js
module.exports = {
  buildCodexArgs,
  extractCodexEventInfo,
  formatCodexJsonLine,
  redactOutput,
  runCodexOnce,
};
```

Add new neutral exports only after existing tests pass.

- [ ] **Step 4: Add regression tests**

Test that Codex args and output parsing remain unchanged after refactor.

Run: `node test/run.js`
Expected: PASS with no user-visible Codex behavior changes.

---

### Task 4: Add Provider-Aware Configuration

**Files:**
- Modify: `src/config.js`
- Modify: `.env.example`
- Modify: `.env.advanced.example`
- Modify: `README.md`
- Test: `test/run.js`

- [ ] **Step 1: Add neutral environment variables**

Add new settings:

```env
AGENT_PROVIDER=codex
AGENT_BIN=codex
AGENT_EXTRA_ARGS=/absolute/path/to/agent-extra-args.json
AGENT_RESUME_LAST=false
AGENT_SHOW_COMMAND_EVENTS=false
```

- [ ] **Step 2: Preserve Codex fallbacks**

Define precedence:
- `AGENT_PROVIDER` defaults to `codex`.
- `AGENT_BIN` defaults to `CODEX_BIN` when set, otherwise the provider default binary.
- `AGENT_EXTRA_ARGS` defaults to `CODEX_EXTRA_ARGS` when set.
- `AGENT_RESUME_LAST` defaults to `CODEX_RESUME_LAST` when set.
- `AGENT_SHOW_COMMAND_EVENTS` defaults to `CODEX_SHOW_COMMAND_EVENTS` when set.

- [ ] **Step 3: Keep Codex-specific options where needed**

Keep `CODEX_SKIP_GIT_REPO_CHECK` as Codex-specific unless another provider has equivalent behavior. Do not make it a generic agent setting without matching semantics.

- [ ] **Step 4: Expose provider info in status/debug output**

Where useful, show:
- Provider ID.
- Provider display name.
- Binary path.
- Capability flags.

Do not leak secrets or full environment values.

- [ ] **Step 5: Add config tests**

Test cases:
- Empty provider config defaults to Codex.
- `CODEX_BIN` still controls the default Codex binary.
- `AGENT_BIN` takes precedence over `CODEX_BIN`.
- Unknown `AGENT_PROVIDER` throws a clear error.

---

### Task 5: Migrate Session State Names Safely

**Files:**
- Modify: `src/session-manager.js`
- Modify: `src/state-store.js`
- Modify: `src/dashboard.js` if it displays Codex-specific state
- Test: `test/run.js`

- [ ] **Step 1: Add neutral state fields**

Introduce `agentThreadId` internally while preserving `codexThreadId` migration:

```js
agentThreadId: restored.agentThreadId || restored.codexThreadId || ''
```

- [ ] **Step 2: Save both fields during a transition period**

For compatibility with older versions, state can temporarily write:

```js
agentThreadId: session.agentThreadId || '',
codexThreadId: session.agentThreadId || session.codexThreadId || '',
```

- [ ] **Step 3: Rename local variables gradually**

Prefer `agentThreadId`, `agentRunning`, `agentOutput`, and `agentProvider` in new code. Avoid broad unrelated churn in command names during the first pass.

- [ ] **Step 4: Add state migration tests**

Test cases:
- Old state containing only `codexThreadId` restores into `agentThreadId`.
- New state containing `agentThreadId` works without `codexThreadId`.
- Saving state does not drop legacy compatibility prematurely.

---

### Task 6: Add Claude CLI Adapter in Conservative Text Mode

**Files:**
- Create: `src/agent-providers/claude.js`
- Modify: `src/agent-providers/index.js`
- Modify: `README.md`
- Test: `test/run.js`

- [ ] **Step 1: Verify Claude CLI syntax on the target host**

Before finalizing the adapter, run or ask the operator to run:

```sh
claude --help
claude --version
```

If available, also inspect non-interactive and JSON output flags. Do not guess unsupported flags.

- [ ] **Step 2: Implement a minimal provider with explicit limitations**

Start with conservative capability flags:

```js
{
  id: 'claude',
  displayName: 'Claude',
  defaultBin: 'claude',
  supportsJsonEvents: false,
  supportsResume: false,
  supportsImages: false,
  supportsSandboxMode: false,
}
```

- [ ] **Step 3: Build only verified args**

If Claude supports stdin prompt execution, use that. If it requires a print/non-interactive flag, only add the verified flag. Keep `extraArgs` as an escape hatch for deployments:

```env
AGENT_PROVIDER=claude
AGENT_BIN=claude
AGENT_EXTRA_ARGS=/opt/codex-telegram-bridge/claude-extra-args.json
```

- [ ] **Step 4: Parse text output safely**

For non-JSON output:
- Forward stdout chunks as assistant text.
- Forward stderr only after redaction and preferably as diagnostic text.
- Do not try to extract command execution events unless Claude provides structured events.
- Do not store a thread ID unless Claude exposes one reliably.

- [ ] **Step 5: Add Claude adapter tests without requiring Claude installed**

Unit-test args builder and parser only. Do not make CI require the `claude` binary.

---

### Task 7: Add Antigravity Adapter Placeholder

**Files:**
- Create: `src/agent-providers/antigravity.js`
- Modify: `src/agent-providers/index.js`
- Modify: `README.md`
- Test: `test/run.js`

- [ ] **Step 1: Confirm Antigravity CLI exists and supports automation**

Before implementing full support, verify:

```sh
antigravity --help
antigravity --version
```

Also confirm:
- Non-interactive prompt mode.
- Cwd/project selection flag.
- JSON or machine-readable output support.
- Image attachment support.
- Session/resume support.
- Any sandbox or permission controls.

- [ ] **Step 2: Add a registered but guarded provider**

If syntax is unknown, fail clearly:

```js
throw new Error('Antigravity provider is not configured yet. Set AGENT_EXTRA_ARGS after verifying Antigravity CLI non-interactive syntax.');
```

- [ ] **Step 3: Allow an experimental override only if safe**

Optionally support a deployment-only escape hatch such as:

```env
ANTIGRAVITY_EXPERIMENTAL_ARGS_JSON=/absolute/path/to/antigravity-args.json
```

Do not expose this as stable support until tested.

- [ ] **Step 4: Add placeholder tests**

Test that selecting Antigravity without verified config fails with an actionable message.

---

### Task 8: Update Telegram UX Without Breaking Existing Commands

**Files:**
- Modify: `src/commands.js`
- Modify: `src/bot-commands.js`
- Modify: `src/session-manager.js`
- Modify: `README.md`
- Test: `test/run.js`

- [ ] **Step 1: Keep existing Codex command aliases**

These must remain valid:
- `/codex-last`
- `/codex_last`
- `/fix-last`
- `/fix_last`
- Existing callback data such as `codex:last-output` if already used in chats.

- [ ] **Step 2: Add neutral aliases**

Add neutral aliases for future providers:
- `/agent-last`
- `/agent_last`
- Callback data such as `agent:last-output`.

- [ ] **Step 3: Make UI labels provider-aware**

Examples:
- `Send output to Codex` when provider is Codex.
- `Send output to agent` or `Send output to Claude` for other providers.
- Status line includes `agent: Codex running` or `agent: Claude running`.

- [ ] **Step 4: Preserve audit readability**

Keep old audit event names or add provider fields:

```js
{
  type: 'agent.started',
  provider: 'claude',
  legacyType: 'codex.started'
}
```

Prefer adding new `agent.*` events while avoiding sudden removal of `codex.*` if downstream tooling depends on them.

---

### Task 9: Update Documentation and Examples

**Files:**
- Modify: `README.md`
- Modify: `.env.example`
- Modify: `.env.advanced.example`
- Optional Create: `docs/agent-providers.md`

- [ ] **Step 1: Document default Codex setup**

Make clear that existing users do not need to change anything:

```env
AGENT_PROVIDER=codex
# AGENT_BIN defaults to CODEX_BIN or codex
```

- [ ] **Step 2: Document Claude setup as conditional support**

Example:

```env
AGENT_PROVIDER=claude
AGENT_BIN=claude
AGENT_EXTRA_ARGS=/opt/codex-telegram-bridge/claude-extra-args.json
```

List limitations until verified:
- Resume may be unavailable.
- Command event display may be unavailable without JSON output.
- Sandbox behavior may not match Codex.
- Image support depends on CLI capabilities.

- [ ] **Step 3: Document Antigravity status honestly**

Use clear wording such as:
- “Antigravity provider is scaffolded but requires CLI syntax verification.”
- “Do not enable in production until non-interactive mode and output parsing are tested.”

- [ ] **Step 4: Add troubleshooting**

Common failures:
- Unsupported provider ID.
- Binary not found in service PATH.
- Provider does not support resume.
- Provider does not emit JSON events.
- Provider ignores sandbox settings.

---

### Task 10: Validate With Focused Tests

**Files:**
- Modify: `test/run.js`
- Test command: `node test/run.js`

- [ ] **Step 1: Add provider selection tests**

Cases:
- Defaults to Codex.
- Resolves Codex provider by ID.
- Rejects unknown provider.
- Uses provider default binary when no binary is configured.
- Honors `AGENT_BIN` precedence.

- [ ] **Step 2: Add Codex regression tests**

Cases:
- Normal exec args match old behavior.
- Resume by explicit thread ID matches old behavior.
- Resume-last matches old behavior.
- `--image` args are preserved.
- `--skip-git-repo-check` remains Codex-only.
- Agent message parsing remains unchanged.
- Command-event formatting remains unchanged.

- [ ] **Step 3: Add text-provider parser tests**

Cases:
- Plain stdout returns user-visible text.
- Empty chunks are ignored.
- Stderr is redacted before display.
- No thread ID is extracted from unstructured output.

- [ ] **Step 4: Add state migration tests**

Cases:
- `codexThreadId` restores as `agentThreadId`.
- `agentThreadId` is saved.
- Legacy field remains during transition.

- [ ] **Step 5: Run full test suite**

Run:

```sh
node test/run.js
```

Expected: PASS.

---

### Rollout Strategy

- [ ] **Phase 1: Provider abstraction with Codex only**

Refactor Codex into an adapter while keeping all public behavior unchanged. Ship this first if tests are green.

- [ ] **Phase 2: Neutral config and state migration**

Add `AGENT_*` variables, preserve `CODEX_*` fallbacks, and migrate state names safely.

- [ ] **Phase 3: Claude text-mode support**

Enable Claude only after verifying CLI syntax on the host. Start without resume/images/sandbox parity unless proven available.

- [ ] **Phase 4: Antigravity scaffold**

Add provider registration and docs, but keep it guarded until real CLI behavior is verified.

- [ ] **Phase 5: Capability parity improvements**

Add JSON streaming, resume, images, and richer command-event display per provider as their CLIs support it.

---

### Acceptance Criteria

- [ ] Existing Codex deployments work without changing `.env`.
- [ ] Existing `CODEX_*` environment variables remain supported.
- [ ] `AGENT_PROVIDER=codex` produces the same args and parsing behavior as the current implementation.
- [ ] Unknown providers fail fast with a clear error.
- [ ] Provider capability flags prevent misleading UX for resume, images, sandbox, and command events.
- [ ] Old state containing `codexThreadId` continues to restore correctly.
- [ ] Tests cover provider selection, Codex regressions, config precedence, and state migration.
- [ ] README documents Codex as stable, Claude as conditional on verified CLI syntax, and Antigravity as scaffolded/experimental until verified.
