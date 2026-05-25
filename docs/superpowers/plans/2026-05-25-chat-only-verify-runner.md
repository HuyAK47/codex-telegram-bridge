# Chat-Only Verify Runner Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let Telegram users send one message and wait while the bridge automatically loops through Codex edits, background verification, log analysis, and retry until success or a real blocker.

**Architecture:** Keep the current Telegram bot as the orchestrator. Codex remains responsible for code changes and reasoning, while a separate verify-job layer runs heavy toolchains asynchronously outside the Codex sandbox, reports progress back to chat, and can feed failed output back into Codex for another fix pass. Session state tracks both Codex activity and verify jobs so the user only sees one conversational flow.

**Tech Stack:** Node.js 12 CommonJS, Telegram Bot HTTP API, Codex CLI, built-in `child_process`, JSON state files, existing `test/run.js` harness, no required third-party queue system for the first release.

---

### Task 1: Model Verify Jobs and Session State

**Files:**
- Create: `src/verify-jobs.js`
- Create: `src/verify-state.js`
- Modify: `src/session-manager.js`
- Modify: `src/dashboard.js`
- Test: `test/run.js`

- [ ] **Step 1: Add failing tests for verify job state**

```js
test('SessionManager tracks an active verify job separately from Codex', () => {
  const manager = new SessionManager(config, () => {}, fakeDeps);
  manager.startVerifyJob(1, {
    label: 'Flutter Test',
    repoAlias: 'mobile',
    command: 'flutter test',
    cwd: '/repo/mobile',
  });

  const status = manager.status(1);

  assert.equal(status.verifyRunning, true);
  assert.equal(status.verifyLabel, 'Flutter Test');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node test/run.js`
Expected: FAIL because `startVerifyJob`, `verifyRunning`, and `verifyLabel` do not exist yet.

- [ ] **Step 3: Add a lightweight verify job domain model**

```js
function createVerifyJob(fields) {
  return {
    id: fields.id,
    label: fields.label,
    repoAlias: fields.repoAlias,
    workspace: fields.workspace,
    cwd: fields.cwd,
    command: fields.command,
    status: fields.status || 'queued',
    attempts: fields.attempts || 0,
    startedAt: fields.startedAt || 0,
    finishedAt: fields.finishedAt || 0,
    lastExitCode: fields.lastExitCode == null ? null : fields.lastExitCode,
    lastOutput: fields.lastOutput || '',
    sourcePrompt: fields.sourcePrompt || '',
  };
}
```

- [ ] **Step 4: Extend session state and dashboard snapshot**

```js
this.sessions.set(key, {
  // existing fields...
  verifyJob: null,
  verifyQueue: [],
  autoLoopEnabled: false,
  autoLoopAttempts: 0,
});
```

- [ ] **Step 5: Re-run tests and keep dashboard output green**

Run: `node test/run.js`
Expected: PASS for new verify-state tests and no regression in `snapshot()` / `status()`.

---

### Task 2: Introduce Runner Profiles With Explicit Working Directories

**Files:**
- Create: `src/verify-profiles.js`
- Modify: `src/config.js`
- Modify: `.env.example`
- Modify: `README.md`
- Test: `test/run.js`

- [ ] **Step 1: Add failing tests for explicit verify profiles**

```js
test('verify profiles can target a subdirectory and shell command', () => {
  const profiles = parseVerifyProfiles('{"chess-mobile":{"cwd":"mobile","command":"flutter test"}}');
  assert.equal(profiles.get('chess-mobile').cwd, 'mobile');
  assert.equal(profiles.get('chess-mobile').command, 'flutter test');
});
```

- [ ] **Step 2: Run tests to verify config support is missing**

Run: `node test/run.js`
Expected: FAIL because `parseVerifyProfiles` and `VERIFY_PROFILES_JSON` are not implemented.

- [ ] **Step 3: Add a config parser for background verify runners**

```js
function parseVerifyProfiles(value) {
  const map = new Map();
  if (!value || !value.trim()) {
    return map;
  }
  const parsed = JSON.parse(value);
  for (const name of Object.keys(parsed)) {
    const entry = parsed[name];
    map.set(name, {
      cwd: entry.cwd || '',
      command: entry.command || '',
      successText: entry.successText || '',
      kind: entry.kind || 'shell',
    });
  }
  return map;
}
```

- [ ] **Step 4: Document the new shape with module-level paths**

```env
VERIFY_PROFILES_JSON='{
  "chess-mobile":{"cwd":"mobile","command":"flutter test"},
  "chess-backend":{"cwd":"backend","command":"./gradlew --no-daemon test"},
  "bonsai-app":{"cwd":".","command":"dart test"}
}'
```

- [ ] **Step 5: Re-run tests**

Run: `node test/run.js`
Expected: PASS with new config coverage and no breakage to existing `REPO_PROFILES_JSON`.

---

### Task 3: Add an Async Verify Runner Layer

**Files:**
- Create: `src/verify-runner.js`
- Modify: `src/session-manager.js`
- Modify: `src/commands.js`
- Test: `test/run.js`

- [ ] **Step 1: Add failing tests for non-blocking verify execution**

```js
test('verify runner reports queued, started, and finished events', async () => {
  const events = [];
  const runner = createVerifyRunner({
    runCommand: async () => ({ code: 1, output: 'failing test output' }),
    onEvent: (event) => events.push(event),
  });

  await runner.enqueue({
    id: 'job-1',
    label: 'Flutter Test',
    cwd: '/repo/mobile',
    command: 'flutter test',
  });

  assert.deepEqual(events.map((event) => event.type), [
    'verify.queued',
    'verify.started',
    'verify.finished',
  ]);
});
```

- [ ] **Step 2: Run tests to verify the runner does not exist yet**

Run: `node test/run.js`
Expected: FAIL because `createVerifyRunner` and verify event wiring are missing.

- [ ] **Step 3: Implement a serialized in-process runner**

```js
function createVerifyRunner(deps) {
  const queue = [];
  let active = null;

  async function pump() {
    if (active || queue.length === 0) {
      return;
    }
    active = queue.shift();
    deps.onEvent({ type: 'verify.started', job: active });
    const result = await deps.runCommand(active);
    deps.onEvent({ type: 'verify.finished', job: active, result });
    active = null;
    await pump();
  }

  return {
    async enqueue(job) {
      queue.push(job);
      deps.onEvent({ type: 'verify.queued', job });
      await pump();
    },
  };
}
```

- [ ] **Step 4: Expose commands that talk to the runner instead of running inline**

```js
if (text === '/test') {
  await sessionManager.enqueueVerifyProfile(chatId, 'default-test');
  return;
}
```

- [ ] **Step 5: Re-run tests**

Run: `node test/run.js`
Expected: PASS with verify queue behavior covered by unit tests.

---

### Task 4: Add Machine-Readable Handoff From Codex to Runner

**Files:**
- Create: `src/verify-intent.js`
- Modify: `src/codex.js`
- Modify: `src/session-manager.js`
- Test: `test/run.js`

- [ ] **Step 1: Add failing tests for parsing verify requests from Codex output**

```js
test('verify intent parser extracts a JSON verify request block', () => {
  const parsed = parseVerifyIntent(`
Done.

\`\`\`verify-request
{"profile":"chess-mobile","reason":"Run flutter regression tests"}
\`\`\`
`);

  assert.equal(parsed.profile, 'chess-mobile');
  assert.match(parsed.reason, /flutter/);
});
```

- [ ] **Step 2: Run tests to verify parser is absent**

Run: `node test/run.js`
Expected: FAIL because `parseVerifyIntent` does not exist.

- [ ] **Step 3: Implement a strict parser with safe fallback**

```js
function parseVerifyIntent(text) {
  const match = String(text || '').match(/```verify-request\\n([\\s\\S]*?)\\n```/);
  if (!match) {
    return null;
  }
  return JSON.parse(match[1]);
}
```

- [ ] **Step 4: Trigger verify jobs automatically only when the parser succeeds**

```js
const verifyIntent = parseVerifyIntent(session.lastAssistantText);
if (verifyIntent) {
  await this.enqueueVerifyProfile(chatId, verifyIntent.profile, verifyIntent.reason);
}
```

- [ ] **Step 5: Re-run tests**

Run: `node test/run.js`
Expected: PASS with no auto-run when Codex output is plain text only.

---

### Task 5: Implement Auto Fix -> Verify -> Retry Loop

**Files:**
- Modify: `src/session-manager.js`
- Modify: `src/commands.js`
- Modify: `src/smart-errors.js`
- Test: `test/run.js`

- [ ] **Step 1: Add failing tests for automatic retries with a hard cap**

```js
test('auto loop sends failed verify output back to Codex until max attempts', async () => {
  const prompts = [];
  const manager = new SessionManager(config, () => {}, fakeDeps);
  manager.ask = (chatId, prompt) => prompts.push(prompt);
  manager.enableAutoLoop(1);

  manager.handleVerifyFinished(1, {
    job: { label: 'Flutter Test', attempts: 1 },
    result: { code: 1, output: 'Expected true, got false' },
  });

  assert.equal(prompts.length, 1);
  assert.match(prompts[0], /Expected true, got false/);
});
```

- [ ] **Step 2: Run tests to verify the loop controls are missing**

Run: `node test/run.js`
Expected: FAIL because `enableAutoLoop` and `handleVerifyFinished` do not exist.

- [ ] **Step 3: Add bounded retry logic**

```js
if (result.code !== 0 && session.autoLoopEnabled && session.autoLoopAttempts < this.config.maxAutoLoopAttempts) {
  session.autoLoopAttempts += 1;
  this.ask(chatId, buildLastCommandPrompt({
    label: job.label,
    command: job.command,
    code: result.code,
    output: result.output,
  }, this.config.maxPromptChars));
}
```

- [ ] **Step 4: Add Telegram controls for the loop**

```js
[{ text: 'Auto Loop On', callback_data: 'autoloop:on' }, { text: 'Auto Loop Off', callback_data: 'autoloop:off' }]
```

- [ ] **Step 5: Re-run tests**

Run: `node test/run.js`
Expected: PASS with retry cap, off switch, and no infinite loop.

---

### Task 6: Improve Chat UX for Long-Running Background Work

**Files:**
- Modify: `src/commands.js`
- Modify: `src/session-manager.js`
- Modify: `src/notifier.js`
- Test: `test/run.js`

- [ ] **Step 1: Add failing tests for progress messages and combined status**

```js
test('status reports both Codex and verify runner state', () => {
  const status = manager.status(1);
  assert.equal(typeof status.running, 'boolean');
  assert.equal(typeof status.verifyRunning, 'boolean');
});
```

- [ ] **Step 2: Run tests to verify the UX fields are incomplete**

Run: `node test/run.js`
Expected: FAIL because `status()` only reports Codex state today.

- [ ] **Step 3: Add user-facing progress updates**

```js
this.notifier(chatId, `🧪 Verify started: ${job.label}`);
this.notifier(chatId, `🧪 Verify failed: ${job.label} (exit ${result.code})`);
this.notifier(chatId, `✅ Verify passed: ${job.label}`);
```

- [ ] **Step 4: Keep the user chat-only**

```js
return [
  `workspace: ${status.workspace || '(not selected)'}`,
  `codex: ${status.running ? 'running' : 'idle'}`,
  `verify: ${status.verifyRunning ? status.verifyLabel : 'idle'}`,
  `autoloop: ${status.autoLoopEnabled ? 'on' : 'off'}`,
].join('\n');
```

- [ ] **Step 5: Re-run tests**

Run: `node test/run.js`
Expected: PASS with richer status output and no Telegram routing regressions.

---

### Task 7: Add Environment-Aware Runner Strategy

**Files:**
- Modify: `src/config.js`
- Modify: `src/verify-runner.js`
- Modify: `.env.example`
- Modify: `README.md`
- Test: `test/run.js`

- [ ] **Step 1: Add failing tests for runner modes**

```js
test('verify runner supports local-shell and detached-shell modes', () => {
  const config = loadConfig({
    ...baseEnv,
    VERIFY_RUNNER_MODE: 'detached-shell',
  });
  assert.equal(config.verifyRunnerMode, 'detached-shell');
});
```

- [ ] **Step 2: Run tests to verify config does not expose runner mode**

Run: `node test/run.js`
Expected: FAIL because `VERIFY_RUNNER_MODE` is not parsed.

- [ ] **Step 3: Add a minimal strategy switch**

```js
return {
  verifyRunnerMode: source.VERIFY_RUNNER_MODE || 'local-shell',
  maxAutoLoopAttempts: Number(source.MAX_AUTO_LOOP_ATTEMPTS || 3),
};
```

- [ ] **Step 4: Document the recommended production mode**

```env
VERIFY_RUNNER_MODE=detached-shell
MAX_AUTO_LOOP_ATTEMPTS=3
```

- [ ] **Step 5: Re-run tests**

Run: `node test/run.js`
Expected: PASS with both default and explicit mode coverage.

---

### Task 8: Final Verification and Operator Docs

**Files:**
- Modify: `README.md`
- Modify: `.env.example`
- Modify: `docs/remote-android-ui.md`
- Modify: `docs/ubuntu-bwrap-fix.md`

- [ ] **Step 1: Document the new operator workflow**

```md
1. User sends one request in Telegram.
2. Codex edits code.
3. Verify runner executes the mapped profile.
4. Failed output is sent back into Codex automatically.
5. The loop stops on success or after the configured retry cap.
```

- [ ] **Step 2: Add environment guidance**

```md
- Keep Flutter SDK, Gradle cache, and .pub-cache writable by the verify runner.
- Prewarm dependencies that require network or native hooks.
- Map monorepo modules to explicit runner profiles with `cwd`.
```

- [ ] **Step 3: Run the full bridge test suite**

Run: `node test/run.js`
Expected: PASS with all bridge unit tests green.

- [ ] **Step 4: Smoke-check command routing**

Run: `node -c src/commands.js`
Expected: exit 0

- [ ] **Step 5: Smoke-check session orchestration**

Run: `node -c src/session-manager.js`
Expected: exit 0
