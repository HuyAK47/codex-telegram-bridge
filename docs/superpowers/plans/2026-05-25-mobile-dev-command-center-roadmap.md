# Mobile Dev Command Center Roadmap

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Turn `codex-telegram-bridge` into a low-friction mobile development command center where the user can manage real coding work from Telegram with one conversational flow instead of remembering many manual steps.

**Architecture:** Keep Telegram as the control surface, `SessionManager` as the orchestrator, Codex as the code-change engine, and the verify runner as the async execution layer for heavy tools. Add guided workflow commands, repo-aware context, and review/summary/branch handoff features so the user can move from request to test, review, commit, and PR readiness without leaving chat unless a real blocker appears.

**Tech Stack:** Node.js 12 CommonJS, Telegram Bot HTTP API, Codex CLI, git CLI, built-in `child_process`, JSON-backed state store, existing `test/run.js` harness, optional GitHub connector in later phases.

---

### Task 1: Stabilize The Runtime Baseline

**Files:**
- Modify: `src/telegram.js`
- Modify: `src/session-manager.js`
- Modify: `src/commands.js`
- Modify: `test/run.js`
- Modify: `README.md`

- [x] **Step 1: Fix blocking runtime defects before adding more workflow surface**
Check and repair syntax or command-path issues that can break the bot before a user reaches the new workflow.

Run:
```bash
node -c src/telegram.js
node -c src/session-manager.js
node -c src/commands.js
```

Expected: all files parse cleanly with exit code `0`.

- [x] **Step 2: Add regression coverage for the repaired defects**
Add tests that prove the repaired behavior stays intact.

Target tests:
```js
test('TelegramClient sendDocument builds a valid multipart request', () => {
  // mock https.request and assert multipart header/footer are valid
});

test('commit request exposes an actionable confirmation path', async () => {
  // assert notifier receives reply_markup with confirm and cancel callbacks
});
```

- [x] **Step 3: Re-run the core test suite**
Run:
```bash
node test/run.js
```

Expected: full suite passes and new regression tests are green.

- [x] **Step 4: Refresh the docs for the repaired baseline**
Update the operator-facing docs so README examples match the real runtime behavior, especially around commit confirmation and verify flow.

---

### Task 2: Complete The Core Mobile Workflow Loop

**Files:**
- Modify: `src/session-manager.js`
- Modify: `src/commands.js`
- Modify: `src/bot-commands.js`
- Modify: `README.md`
- Modify: `test/run.js`

- [x] **Step 1: Finish the `/commit` confirmation UX**
Wire `requestCommit()` to send the same confirm/cancel callback buttons already handled by `commands.js`.

Expected chat flow:
```text
/commit fix login bug
-> Confirm commit?
-> [Confirm commit] [Cancel]
```

- [x] **Step 2: Add `/review` as a read-only Codex command**
Implement a command that asks Codex to inspect the current diff and respond with review findings only.

Prompt contract:
```text
Review the current git diff in this workspace. Find bugs, regressions, incomplete changes, risky edge cases, and missing tests. Do not modify files.
```

- [x] **Step 3: Add `/summary` or `/done` as an end-of-task briefing**
Use session state such as `lastAssistantText`, `lastWorkspaceCommand`, verify job state, and repo info to generate a compact operator summary.

Summary contract:
```text
- what changed
- current changed files
- latest verify result
- remaining risks
- whether the work looks ready to commit
```

- [x] **Step 4: Add `/fix-last` as a friendly alias**
Keep `/codex-last` for compatibility, but add `/fix-last` in help text, command registration, and callback-driven UX so the feature is easier to discover from mobile.

- [x] **Step 5: Re-run workflow tests**
Run:
```bash
node test/run.js
```

Expected: command routing, callback flow, and help text assertions all pass.

---

### Task 3: Add Guided Planning And Repo Memory

**Files:**
- Modify: `src/session-manager.js`
- Modify: `src/commands.js`
- Modify: `src/state-store.js`
- Create: `src/repo-notes.js`
- Modify: `README.md`
- Modify: `test/run.js`

- [x] **Step 1: Add `/plan` as a no-write planning mode**
Implement a command that asks Codex to inspect the relevant code, propose a plan, and stop before editing files.

Prompt contract:
```text
Analyze this task, inspect the relevant code, and propose a concrete implementation plan. Do not modify files yet. Call out risks, tests, and the smallest safe path.
```

- [x] **Step 2: Add plan approval affordances**
Store the latest plan response in session state and expose follow-up actions such as:
```text
[Approve & Run] [Revise Plan] [Cancel]
```

The first version can map these buttons to: rerun the last task in write mode, ask Codex to revise the plan, or clear the pending plan.

- [x] **Step 3: Add repo-scoped notes**
Create a simple repo memory file under a stable project-owned path such as:
```text
.codex-telegram/context.md
```

The bridge should support:
```text
/note app này dùng Riverpod
/note không tự đổi schema DB
```

- [x] **Step 4: Prepend repo memory safely**
When a workspace has saved notes, prepend them to Codex prompts in a bounded way so the model gets durable context without flooding every request.

- [x] **Step 5: Add tests for planning and notes**
Run:
```bash
node test/run.js
```

Expected: tests cover stored plan state, note persistence, prompt augmentation, and button callbacks.

---

### Task 4: Make Repo Profiles First-Class

**Files:**
- Modify: `src/config.js`
- Modify: `src/commands.js`
- Modify: `src/session-manager.js`
- Modify: `src/verify-profiles.js`
- Modify: `.env.example`
- Modify: `README.md`
- Modify: `test/run.js`

- [x] **Step 1: Expand repo profiles beyond verify commands**
Promote profiles into a central operator configuration that can describe:
```json
{
  "chess": {
    "cwd": "mobile",
    "notesPath": ".codex-telegram/context.md",
    "commands": {
      "Analyze": "flutter analyze",
      "Test": "flutter test",
      "Format": "dart format lib test",
      "Build APK": "flutter build apk --split-per-abi"
    }
  }
}
```

- [x] **Step 2: Generate command buttons from the active repo profile**
Update the main keyboard and workflow keyboards so the operator sees repo-relevant actions instead of a static global set whenever possible.

- [x] **Step 3: Make `/apk` a profile-driven command**
Keep the existing shortcut, but resolve it from repo profile data rather than hard-coding Flutter build logic inside `SessionManager`.

- [x] **Step 4: Add profile-aware fallbacks**
If a repo has no custom profile, keep the current generic commands available so the bridge remains useful in plain git repositories.

- [x] **Step 5: Verify the profile matrix**
Run:
```bash
node test/run.js
```

Expected: parsing, button generation, cwd resolution, and command execution tests all pass.

---

### Task 5: Improve Attachment And Intent UX

**Files:**
- Modify: `src/attachments.js`
- Modify: `src/commands.js`
- Modify: `src/session-manager.js`
- Modify: `README.md`
- Modify: `test/run.js`

- [x] **Step 1: Add intent prompts for image-only messages**
If the user sends an image without text, respond with quick actions like:
```text
[Review UI] [Find bug] [Implement similar screen] [Attach only]
```

- [x] **Step 2: Map quick actions to stable prompts**
Each action should produce a deterministic prompt template so Codex gets useful context instead of a vague image-only request.

- [x] **Step 3: Keep text-plus-image behavior direct**
If the user sends both image and text, continue forwarding both to Codex without extra confirmation unless the attachment handling fails.

- [x] **Step 4: Add tests for attachment-driven flows**
Run:
```bash
node test/run.js
```

Expected: tests cover image-only decision prompts and text-plus-image passthrough.

---

### Task 6: Add Branch And PR Readiness Workflow

**Files:**
- Modify: `src/workspace-tools.js`
- Modify: `src/session-manager.js`
- Modify: `src/commands.js`
- Modify: `src/bot-commands.js`
- Modify: `README.md`
- Modify: `test/run.js`

- [x] **Step 1: Add `/branch <name>`**
Introduce a safe wrapper for:
```bash
git -C <workspace> checkout -b <name>
```

Gate it behind confirmed write mode and reject invalid branch names.

- [x] **Step 2: Add `/pr-ready` as a summary command**
Gather `git diff --stat`, changed files, latest verify output, and recent commits, then ask Codex to produce a concise “ready for PR” summary.

- [x] **Step 3: Keep local-first assumptions**
Do not require GitHub integration in the first version. The output should still be useful as a PR body draft or a handoff note even without remote APIs.

- [x] **Step 4: Add regression tests for branch safety**
Run:
```bash
node test/run.js
```

Expected: invalid branch names are rejected, branch command builders are safe, and `/pr-ready` routing works.

---

### Task 7: Deepen Status, Audit, And Dashboard Support

**Files:**
- Modify: `src/dashboard.js`
- Modify: `src/session-manager.js`
- Modify: `src/commands.js`
- Modify: `README.md`
- Modify: `test/run.js`

- [x] **Step 1: Expand session status to reflect workflow state**
Expose whether the session is:
```text
- idle
- planning
- coding
- verifying
- waiting for commit confirmation
- waiting for plan approval
```

- [x] **Step 2: Surface recent workflow history**
Extend the dashboard and `/status` response with recent milestones such as last command, last verify result, pending plan, pending commit, and active repo notes state.

- [x] **Step 3: Improve audit readability**
Add audit event types for planning, review, summary generation, branch creation, and note updates so operator history remains searchable.

- [x] **Step 4: Verify snapshots and status rendering**
Run:
```bash
node test/run.js
```

Expected: dashboard snapshot tests and status formatting tests stay green.

---

### Task 8: Optional GitHub And Release Integrations

**Files:**
- Modify: `src/session-manager.js`
- Modify: `src/commands.js`
- Modify: `README.md`
- Modify: `test/run.js`
- Optional future files: `src/github.js`, `src/release.js`

- [x] **Step 1: Keep this phase strictly optional**
Only start after the local-first workflow is stable and used regularly. The bridge should already be valuable before any external API work begins.

- [x] **Step 2: Add PR and CI helpers incrementally**
Possible additions:
```text
/pr-create
/checks
/rerun-failed
```

Each should have a local fallback or a clear “not configured” message.

- [x] **Step 3: Keep release helpers profile-driven**
If APK promotion or other release tasks are added later, resolve them from repo profile commands instead of hard-coding product-specific release flows in `SessionManager`.

---

### Task 9: Rollout Sequence

**Files:**
- No code changes in this task. This is the delivery order for the roadmap above.

- [x] **Step 1: Finish Phase A**
Scope:
```text
Task 1 + commit UX from Task 2
```

Definition of done:
```text
- no syntax/runtime blockers in core files
- commit confirmation uses inline buttons
- full test suite green
```

- [x] **Step 2: Finish Phase B**
Scope:
```text
remaining Task 2 + Task 5
```

Definition of done:
```text
- operator can ask for review, summary, and fix-last from chat
- image-driven UI review flow works
- help text and buttons expose the new workflow clearly
```

- [x] **Step 3: Finish Phase C**
Scope:
```text
Task 3 + Task 4
```

Definition of done:
```text
- /plan exists with approval loop
- repo notes persist cleanly
- repo profiles drive commands and build actions
```

- [x] **Step 4: Finish Phase D**
Scope:
```text
Task 6 + Task 7
```

Definition of done:
```text
- branch workflow is safe
- pr-ready summary is useful
- dashboard and status reflect the whole operator workflow
```

- [x] **Step 5: Evaluate Phase E**
Scope:
```text
Task 8
```

Definition of done:
```text
- only pursued if the local-first workflow is already stable and heavily used
```

---

### Task 10: Verification Strategy For Every Phase

**Files:**
- Modify as needed in each phase: `test/run.js`, `README.md`

- [x] **Step 1: Run the core regression suite after each phase**
Run:
```bash
node test/run.js
```

- [x] **Step 2: Run syntax checks for every touched module**
Examples:
```bash
node -c src/telegram.js
node -c src/commands.js
node -c src/session-manager.js
```

- [x] **Step 3: Re-read the README after workflow changes**
Every operator-visible command or button change should be mirrored in the docs before the phase is considered done.

- [ ] **Step 4: Prefer small commits at phase boundaries**
Suggested commit grouping:
```text
fix: repair telegram runtime and commit confirmation flow
feat: add review summary and fix-last workflow
feat: add plan approval and repo notes
feat: add repo-driven command profiles
feat: add branch and pr-ready workflow
```

---

### Notes For Execution

- This roadmap is intentionally local-first. Do not block early value on GitHub, CI, or release automation.
- `SessionManager` should remain the orchestration boundary, but if it grows too large during these phases, split out focused helpers rather than piling more branching logic into one file.
- Keep all new mobile flows discoverable from inline keyboards and `/help`, not only from README.
- Protect every write-capable workflow with the same safety posture already used for workspace writes: explicit operator intent, safe command builders, and tests for negative cases.
