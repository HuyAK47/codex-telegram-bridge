const assert = require('assert').strict;
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const { spawnSync } = require('child_process');
const { Writable } = require('stream');

const {
  buildSafeEnv,
  chunkTelegramMessage,
  parseAllowedUserIds,
  redactSensitiveText,
  resolveAllowedWorkspace,
  validateTelegramText,
} = require('../src/security');
const { loadConfig, parseKeyValueMap } = require('../src/config');
const { formatCodexJsonLine } = require('../src/codex');
const { createCommandHandler } = require('../src/commands');
const { SessionManager } = require('../src/session-manager');
const { StateStore } = require('../src/state-store');
const { parseVerifyProfiles, resolveVerifyProfile } = require('../src/verify-profiles');
const { createVerifyRunner } = require('../src/verify-runner');
const { buildSmartErrorResponse } = require('../src/smart-errors');
const { createSessionNotifier } = require('../src/notifier');
const { promptNeedsWrite } = require('../src/intent');
const { parseRepoProfiles } = require('../src/repo-profiles');
const { pickLargestPhoto, safeAttachmentPath } = require('../src/attachments');
const { buildHealthReport } = require('../src/health');
const { cleanupAttachments } = require('../src/cleanup');
const { buildBotCommands } = require('../src/bot-commands');
const { TelegramClient } = require('../src/telegram');
const { readRepoNotes } = require('../src/repo-notes');
const { AuditLogger } = require('../src/audit');
const { detectTestCommand } = require('../src/test-command-detector');
const {
  buildDiffCommand,
  buildFilesCommand,
  buildTestCommand,
  buildBranchCommand,
  buildCommitCommand,
  buildPrReadyCommand,
} = require('../src/workspace-tools');

const tests = [];

function test(name, fn) {
  tests.push({ name, fn });
}

test('parseAllowedUserIds requires an explicit numeric allowlist', () => {
  assert.deepEqual(parseAllowedUserIds('123, 456'), new Set([123, 456]));
  assert.throws(() => parseAllowedUserIds(''), /TELEGRAM_ALLOWED_USER_IDS/);
  assert.throws(() => parseAllowedUserIds('123,abc'), /numeric/);
});

test('resolveAllowedWorkspace only permits paths inside allowlisted roots', () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-root-'));
  const allowedRepo = path.join(tempRoot, 'repo');
  fs.mkdirSync(allowedRepo);

  assert.equal(resolveAllowedWorkspace(allowedRepo, [tempRoot]), fs.realpathSync(allowedRepo));
  assert.throws(() => resolveAllowedWorkspace('/etc', [tempRoot]), /not allowlisted/);
});

test('resolveAllowedWorkspace rejects symlink escapes', () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-root-'));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-outside-'));
  const linkPath = path.join(tempRoot, 'escape');
  fs.symlinkSync(outside, linkPath);

  assert.throws(() => resolveAllowedWorkspace(linkPath, [tempRoot]), /not allowlisted/);
});

test('validateTelegramText blocks oversized and binary-looking input', () => {
  assert.equal(validateTelegramText('fix the login bug'), 'fix the login bug');
  assert.throws(() => validateTelegramText('x'.repeat(20001)), /too long/);
  assert.throws(() => validateTelegramText('hello\u0000world'), /control characters/);
});

test('redactSensitiveText removes configured secret values and token-shaped lines', () => {
  const redacted = redactSensitiveText('token=abc123\nsecret is shhh', {
    TELEGRAM_BOT_TOKEN: 'abc123',
    OTHER_SECRET: 'shhh',
  });

  assert.equal(redacted.includes('abc123'), false);
  assert.equal(redacted.includes('shhh'), false);
  assert.match(redacted, /\[REDACTED/);
});

test('buildSafeEnv passes only minimal environment and explicit Codex auth values', () => {
  const env = buildSafeEnv({
    HOME: '/home/me',
    PATH: '/bin',
    LANG: 'en_US.UTF-8',
    TELEGRAM_BOT_TOKEN: 'never-pass',
    OPENAI_API_KEY: 'allowed',
    RANDOM_SECRET: 'nope',
  });

  assert.equal(env.HOME, '/home/me');
  assert.equal(env.PATH, '/bin');
  assert.equal(env.OPENAI_API_KEY, 'allowed');
  assert.equal(env.TELEGRAM_BOT_TOKEN, undefined);
  assert.equal(env.RANDOM_SECRET, undefined);
});

test('chunkTelegramMessage respects Telegram message size limits', () => {
  const chunks = chunkTelegramMessage('x'.repeat(9000), 4000);

  assert.equal(chunks.length, 3);
  assert.equal(chunks.every((chunk) => chunk.length <= 4000), true);
  assert.equal(chunks.join(''), 'x'.repeat(9000));
});

test('formatCodexJsonLine extracts assistant text and hides lifecycle noise', () => {
  assert.equal(formatCodexJsonLine('{"type":"thread.started","thread_id":"t"}'), '');
  assert.equal(formatCodexJsonLine('{"type":"turn.started"}'), '');
  assert.equal(
    formatCodexJsonLine('{"type":"item.completed","item":{"type":"agent_message","text":"alo"}}'),
    'alo'
  );
});

test('formatCodexJsonLine hides non-message item lifecycle noise', () => {
  assert.equal(formatCodexJsonLine('{"type":"item.started","item":{"type":"reasoning"}}'), '');
  assert.equal(formatCodexJsonLine('{"type":"item.updated","item":{"type":"reasoning"}}'), '');
});

test('Codex event helpers extract thread and assistant context', () => {
  const { extractCodexEventInfo, buildCodexArgs } = require('../src/codex');
  assert.deepEqual(extractCodexEventInfo('{"type":"thread.started","thread_id":"abc"}'), { threadId: 'abc' });
  assert.deepEqual(
    extractCodexEventInfo('{"type":"item.completed","item":{"type":"agent_message","text":"done"}}'),
    { assistantText: 'done' }
  );
  assert.deepEqual(buildCodexArgs({ resumeSessionId: 'abc', imagePaths: [], extraArgs: [] }), ['exec', 'resume', '--json', 'abc', '-']);
});


test('TelegramClient sendDocument builds a valid multipart request', async () => {
  const https = require('https');
  const originalRequest = https.request;
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-upload-'));
  const uploadPath = path.join(tempRoot, 'app.apk');
  fs.writeFileSync(uploadPath, 'APKDATA');
  const writes = [];
  let capturedOptions = null;

  https.request = (url, options, callback) => {
    capturedOptions = options;
    const req = new Writable({
      write(chunk, _encoding, done) {
        writes.push(Buffer.from(chunk));
        done();
      }
    });
    req.end = (chunk) => {
      if (chunk) {
        writes.push(Buffer.from(chunk));
      }
      const res = new EventEmitter();
      res.setEncoding = () => {};
      callback(res);
      process.nextTick(() => {
        res.emit('data', '{"ok":true,"result":{"document_id":"doc"}}');
        res.emit('end');
      });
    };
    return req;
  };

  try {
    const result = await new TelegramClient('token').sendDocument(123, uploadPath, { caption: 'Build APK' });
    const body = Buffer.concat(writes).toString('utf8');

    assert.equal(result.document_id, 'doc');
    assert.match(capturedOptions.headers['Content-Type'], /^multipart\/form-data; boundary=/);
    assert.match(body, /name="chat_id"\r\n\r\n123/);
    assert.match(body, /name="caption"\r\n\r\nBuild APK/);
    assert.match(body, /name="document"; filename="app.apk"/);
    assert.match(body, /Content-Type: application\/octet-stream\r\n\r\nAPKDATA\r\n--/);
    assert.match(body, /--\r\n$/);
  } finally {
    https.request = originalRequest;
  }
});

test('formatCodexJsonLine summarizes command execution events', () => {
  assert.equal(
    formatCodexJsonLine('{"type":"item.started","item":{"type":"command_execution","command":"npm test"}}'),
    ''
  );
  assert.equal(
    formatCodexJsonLine('{"type":"item.started","item":{"type":"command_execution","command":"npm test"}}', {
      showCommandEvents: true,
    }),
    '⚙️ Running: npm test'
  );
  assert.equal(
    formatCodexJsonLine('{"type":"item.completed","item":{"type":"command_execution","command":"npm test","aggregated_output":"ok\\n","exit_code":0,"status":"completed"}}'),
    ''
  );
  assert.match(
    formatCodexJsonLine('{"type":"item.completed","item":{"type":"command_execution","command":"npm test","aggregated_output":"ok\\n","exit_code":0,"status":"completed"}}', {
      showCommandEvents: true,
    }),
    /Command completed exit 0: npm test\nok/
  );
});

test('loadConfig rejects default write mode unless write is explicitly enabled', () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-config-'));
  assert.throws(() => loadConfig({
    TELEGRAM_BOT_TOKEN: 'token',
    TELEGRAM_ALLOWED_USER_IDS: '123',
    WORKSPACE_ALLOWLIST: tempRoot,
    DEFAULT_WORKSPACE: tempRoot,
    DEFAULT_CODEX_MODE: 'write',
    ALLOW_WRITE_MODE: 'false',
  }), /requires ALLOW_WRITE_MODE=true/);

  const config = loadConfig({
    TELEGRAM_BOT_TOKEN: 'token',
    TELEGRAM_ALLOWED_USER_IDS: '123',
    WORKSPACE_ALLOWLIST: tempRoot,
    DEFAULT_WORKSPACE: tempRoot,
    DEFAULT_CODEX_MODE: 'write',
    ALLOW_WRITE_MODE: 'true',
  });
  assert.equal(config.sandboxMode, 'workspace-write');
  assert.equal(config.allowWriteMode, true);
});

test('SessionManager blocks write mode unless enabled server-side', () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-session-'));
  const config = loadConfig({
    TELEGRAM_BOT_TOKEN: 'token',
    TELEGRAM_ALLOWED_USER_IDS: '123',
    WORKSPACE_ALLOWLIST: tempRoot,
    DEFAULT_WORKSPACE: tempRoot,
    ALLOW_WRITE_MODE: 'false',
  });
  const manager = new SessionManager(config, () => {});

  assert.throws(() => manager.setMode(1, 'write'), /Write mode is disabled/);
  assert.equal(manager.setMode(1, 'read'), 'read-only');
});

test('SessionManager only accepts allowlisted workspaces', () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-session-root-'));
  const config = loadConfig({
    TELEGRAM_BOT_TOKEN: 'token',
    TELEGRAM_ALLOWED_USER_IDS: '123',
    WORKSPACE_ALLOWLIST: tempRoot,
  });
  const manager = new SessionManager(config, () => {});

  assert.equal(manager.setWorkspace(1, tempRoot), fs.realpathSync(tempRoot));
  assert.throws(() => manager.setWorkspace(1, '/etc'), /not allowlisted/);
});

test('loadConfig requires explicit opt-in before passing Codex skip git repo check', () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-skip-git-'));
  const defaultConfig = loadConfig({
    TELEGRAM_BOT_TOKEN: 'token',
    TELEGRAM_ALLOWED_USER_IDS: '123',
    WORKSPACE_ALLOWLIST: tempRoot,
  });
  const optedInConfig = loadConfig({
    TELEGRAM_BOT_TOKEN: 'token',
    TELEGRAM_ALLOWED_USER_IDS: '123',
    WORKSPACE_ALLOWLIST: tempRoot,
    CODEX_SKIP_GIT_REPO_CHECK: 'true',
  });

  assert.equal(defaultConfig.codexSkipGitRepoCheck, false);
  assert.equal(optedInConfig.codexSkipGitRepoCheck, true);
});

test('command handler treats normal chat messages as Codex prompts', async () => {
  const calls = [];
  const sends = [];
  const handler = createCommandHandler(
    { allowedUserIds: new Set([123]), maxPromptChars: 20000, allowWriteMode: false },
    {
      ask(chatId, prompt) {
        calls.push({ chatId, prompt });
      },
    },
    async (chatId, text) => {
      sends.push({ chatId, text });
    }
  );

  await handler({
    message: {
      from: { id: 123 },
      chat: { id: 456 },
      text: 'chào bạn nhé, công việc đang sao rồi',
    },
  });

  assert.deepEqual(calls, [{ chatId: 456, prompt: 'chào bạn nhé, công việc đang sao rồi' }]);
  assert.deepEqual(sends, []);
});

test('command handler keeps unknown slash commands as help errors', async () => {
  const sends = [];
  const handler = createCommandHandler(
    { allowedUserIds: new Set([123]), maxPromptChars: 20000, allowWriteMode: false },
    { ask() { throw new Error('should not ask'); } },
    async (chatId, text) => {
      sends.push({ chatId, text });
    }
  );

  await handler({ message: { from: { id: 123 }, chat: { id: 456 }, text: '/wat' } });

  assert.equal(sends.length, 1);
  assert.match(sends[0].text, /Unknown command/);
});

test('help and status messages include quick action keyboards', async () => {
  const sends = [];
  const handler = createCommandHandler(
    {
      allowedUserIds: new Set([123]),
      maxPromptChars: 20000,
      allowWriteMode: true,
      repoAliases: new Map([['chess', '/repo/chess']]),
    },
    { status() { return { workspace: '/repo/chess', mode: 'read-only', running: false, verbose: false, verifyRunning: true, verifyLabel: 'Test', autoLoopEnabled: true }; } },
    async (chatId, text, options) => sends.push({ chatId, text, options })
  );

  await handler({ message: { from: { id: 123 }, chat: { id: 456 }, text: '/start' } });
  await handler({ message: { from: { id: 123 }, chat: { id: 456 }, text: '/status' } });

  assert.equal(sends.length, 2);
  assert.ok(sends[0].options.reply_markup.inline_keyboard.length > 0);
  assert.ok(sends[1].options.reply_markup.inline_keyboard.length > 0);
  assert.match(sends[1].text, /verify: Test/);
  assert.match(sends[1].text, /autoloop: on/);
});

test('repo list returns picker buttons', async () => {
  const sends = [];
  const handler = createCommandHandler(
    {
      allowedUserIds: new Set([123]),
      maxPromptChars: 20000,
      allowWriteMode: false,
      repoAliases: new Map([['chess', '/repo/chess'], ['bridge', '/repo/bridge']]),
    },
    {},
    async (chatId, text, options) => sends.push({ chatId, text, options })
  );

  await handler({ message: { from: { id: 123 }, chat: { id: 456 }, text: '/repos' } });

  assert.match(sends[0].text, /Choose a repo/);
  assert.deepEqual(sends[0].options.reply_markup.inline_keyboard[0][0], {
    text: 'chess',
    callback_data: 'repo:chess',
  });
});

test('callback query routes repo selection and answers Telegram callback', async () => {
  const answers = [];
  const sends = [];
  const handler = createCommandHandler(
    { allowedUserIds: new Set([123]), maxPromptChars: 20000, repoAliases: new Map([['chess', '/repo/chess']]) },
    { setWorkspace(chatId, alias) { return `/selected/${chatId}/${alias}`; } },
    async (chatId, text) => sends.push({ chatId, text }),
    async (callbackId, text) => answers.push({ callbackId, text })
  );

  await handler({
    callback_query: {
      id: 'cb1',
      from: { id: 123 },
      message: { chat: { id: 456 } },
      data: 'repo:chess',
    },
  });

  assert.deepEqual(answers, [{ callbackId: 'cb1', text: 'OK' }]);
  assert.deepEqual(sends, [{ chatId: 456, text: '✅ Workspace selected:\n/selected/456/chess' }]);
});

test('write mode callback requires confirmation before enabling write', async () => {
  const sends = [];
  const manager = {
    requestWriteMode(chatId) { sends.push({ chatId, text: 'confirm requested' }); },
  };
  const handler = createCommandHandler(
    { allowedUserIds: new Set([123]), maxPromptChars: 20000, allowWriteMode: true },
    manager,
    async (chatId, text, options) => sends.push({ chatId, text, options }),
    async () => {}
  );

  await handler({ callback_query: { id: 'cb1', from: { id: 123 }, message: { chat: { id: 456 } }, data: 'mode:write' } });

  assert.equal(sends[0].text, 'confirm requested');
});

test('workspace tool command builders are fixed and safe', () => {
  assert.deepEqual(buildDiffCommand('/repo'), {
    command: 'git',
    args: ['-C', '/repo', 'diff', '--stat'],
  });
  assert.deepEqual(buildFilesCommand('/repo'), {
    command: 'git',
    args: ['-C', '/repo', 'status', '--short'],
  });
  assert.deepEqual(buildTestCommand('/repo', 'npm test'), {
    command: '/bin/bash',
    args: ['-lc', 'npm test'],
    cwd: '/repo',
  });
  assert.deepEqual(buildCommitCommand('/repo', 'safe message'), {
    command: 'git',
    args: ['-C', '/repo', 'commit', '-m', 'safe message'],
  });
  assert.deepEqual(buildBranchCommand('/repo', 'feature/mobile-flow'), {
    command: 'git',
    args: ['-C', '/repo', 'checkout', '-b', 'feature/mobile-flow'],
  });
  assert.equal(buildPrReadyCommand('/repo').cwd, '/repo');
  assert.throws(() => buildCommitCommand('/repo', 'bad\nmessage'), /single line/);
  assert.throws(() => buildBranchCommand('/repo', '../bad'), /Invalid branch name/);
});

test('SessionManager write mode requires server and repo policy approval', () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-write-policy-'));
  const config = loadConfig({
    TELEGRAM_BOT_TOKEN: 'token',
    TELEGRAM_ALLOWED_USER_IDS: '123',
    WORKSPACE_ALLOWLIST: tempRoot,
    REPO_ALIASES: `allowed=${tempRoot}`,
    ALLOW_WRITE_MODE: 'true',
    WRITE_REPO_ALIASES: 'allowed',
  });
  const manager = new SessionManager(config, () => {});

  manager.setWorkspace(1, 'allowed');
  assert.equal(manager.requestWriteMode(1), true);
  assert.equal(manager.confirmWriteMode(1), 'workspace-write');
});

test('SessionManager auto-expires write mode', () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-write-timeout-'));
  const config = loadConfig({
    TELEGRAM_BOT_TOKEN: 'token',
    TELEGRAM_ALLOWED_USER_IDS: '123',
    WORKSPACE_ALLOWLIST: tempRoot,
    REPO_ALIASES: `allowed=${tempRoot}`,
    ALLOW_WRITE_MODE: 'true',
    WRITE_REPO_ALIASES: 'allowed',
    WRITE_MODE_TTL_MS: '-1',
  });
  const manager = new SessionManager(config, () => {});

  manager.setWorkspace(1, 'allowed');
  manager.confirmWriteMode(1);
  assert.equal(manager.status(1).mode, 'read-only');
});

test('SessionManager commit requires write mode and pending confirmation', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-commit-'));
  const notices = [];
  const config = loadConfig({
    TELEGRAM_BOT_TOKEN: 'token',
    TELEGRAM_ALLOWED_USER_IDS: '123',
    WORKSPACE_ALLOWLIST: tempRoot,
    REPO_ALIASES: `allowed=${tempRoot}`,
    ALLOW_WRITE_MODE: 'true',
    WRITE_REPO_ALIASES: 'allowed',
  });
  const manager = new SessionManager(config, (chatId, text, options) => notices.push({ chatId, text, options }));

  manager.setWorkspace(1, 'allowed');
  assert.rejects(() => manager.requestCommit(1, 'safe message'), /requires confirmed write mode/);
  manager.confirmWriteMode(1);
  await manager.requestCommit(1, 'safe message');
  assert.match(notices[0].text, /Confirm commit/);
  assert.equal(notices[0].options.reply_markup.inline_keyboard[0][0].callback_data, 'commit:confirm');
  assert.equal(notices[0].options.reply_markup.inline_keyboard[0][1].callback_data, 'commit:cancel');
});

test('SessionManager apk requires confirmed write mode', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-apk-mode-'));
  const config = loadConfig({
    TELEGRAM_BOT_TOKEN: 'token',
    TELEGRAM_ALLOWED_USER_IDS: '123',
    WORKSPACE_ALLOWLIST: tempRoot,
    REPO_ALIASES: `app=${tempRoot}`,
    ALLOW_WRITE_MODE: 'true',
    WRITE_REPO_ALIASES: 'app',
  });
  fs.writeFileSync(path.join(tempRoot, 'pubspec.yaml'), 'name: demo\n');
  const manager = new SessionManager(config, () => {});

  manager.setWorkspace(1, 'app');

  await assert.rejects(() => manager.apk(1), /APK build requires confirmed write mode/);
});

test('SessionManager apk uploads built files through telegram client', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-apk-upload-'));
  const apkDir = path.join(tempRoot, 'build/app/outputs/flutter-apk');
  fs.mkdirSync(apkDir, { recursive: true });
  fs.writeFileSync(path.join(tempRoot, 'pubspec.yaml'), 'name: demo\n');
  fs.writeFileSync(path.join(apkDir, 'app-arm64-v8a-release.apk'), 'apk');
  fs.writeFileSync(path.join(apkDir, 'app.apk'), 'universal');

  const runs = [];
  const uploads = [];
  const config = loadConfig({
    TELEGRAM_BOT_TOKEN: 'token',
    TELEGRAM_ALLOWED_USER_IDS: '123',
    WORKSPACE_ALLOWLIST: tempRoot,
    REPO_ALIASES: `app=${tempRoot}`,
    ALLOW_WRITE_MODE: 'true',
    WRITE_REPO_ALIASES: 'app',
  });
  const manager = new SessionManager(
    config,
    () => {},
    {
      runWorkspaceCommand: async (spec, timeoutMs) => {
        runs.push({ spec, timeoutMs });
        return { code: 0, output: 'build ok' };
      },
      telegramClient: {
        async sendDocument(chatId, filePath, options) {
          uploads.push({ chatId, filePath, options });
        },
      },
    }
  );

  manager.setWorkspace(1, 'app');
  manager.confirmWriteMode(1);
  await manager.apk(1);

  assert.equal(runs.length, 1);
  assert.equal(runs[0].spec.command, '/bin/bash');
  assert.equal(uploads.length, 1);
  assert.equal(uploads[0].chatId, 1);
  assert.equal(path.basename(uploads[0].filePath), 'app-arm64-v8a-release.apk');
  assert.equal(uploads[0].options.caption, 'Flutter APK: app-arm64-v8a-release.apk');
});

test('StateStore persists last selected workspace without restoring write mode', () => {
  const statePath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-state-')), 'state.json');
  const store = new StateStore(statePath);

  store.saveSession('456', {
    workspace: '/repo/chess',
    repoAlias: 'chess',
    mode: 'workspace-write',
    verbose: true,
    codexThreadId: 'thread-1',
  });

  assert.deepEqual(store.loadSession('456'), {
    workspace: '/repo/chess',
    repoAlias: 'chess',
    mode: 'read-only',
    verbose: true,
    codexThreadId: 'thread-1',
  });
});

test('SessionManager restores last repo from state store in read-only mode', () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-restore-'));
  const statePath = path.join(tempRoot, 'state.json');
  const config = loadConfig({
    TELEGRAM_BOT_TOKEN: 'token',
    TELEGRAM_ALLOWED_USER_IDS: '123',
    WORKSPACE_ALLOWLIST: tempRoot,
    REPO_ALIASES: `chess=${tempRoot}`,
    SESSION_STATE_PATH: statePath,
  });
  new StateStore(statePath).saveSession('1', {
    workspace: tempRoot,
    repoAlias: 'chess',
    mode: 'workspace-write',
    verbose: true,
  });

  const manager = new SessionManager(config, () => {});
  const status = manager.status(1);

  assert.equal(status.workspace, fs.realpathSync(tempRoot));
  assert.equal(status.mode, 'read-only');
  assert.equal(status.verbose, true);
});

test('SessionManager detects read-only denial and offers enable write retry', () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-denial-'));
  const notices = [];
  const config = loadConfig({
    TELEGRAM_BOT_TOKEN: 'token',
    TELEGRAM_ALLOWED_USER_IDS: '123',
    WORKSPACE_ALLOWLIST: tempRoot,
    REPO_ALIASES: `chess=${tempRoot}`,
    ALLOW_WRITE_MODE: 'true',
    WRITE_REPO_ALIASES: 'chess',
  });
  const manager = new SessionManager(config, (chatId, text, options) => notices.push({ chatId, text, options }));
  manager.setWorkspace(1, 'chess');
  manager.recordPromptForRetry(1, 'fix bug');

  manager.offerWriteRetryIfReadOnlyDenied(1, 'cannot continue in read-only sandbox');

  assert.match(notices[0].text, /Enable write mode and retry/);
  assert.equal(notices[0].options.reply_markup.inline_keyboard[0][0].callback_data, 'mode:write:retry');
});

test('command handler supports work windows and write retry callback', async () => {
  const calls = [];
  const handler = createCommandHandler(
    { allowedUserIds: new Set([123]), maxPromptChars: 20000, allowWriteMode: true },
    {
      enableWriteWindow(chatId, minutes) { calls.push({ method: 'work', chatId, minutes }); return 'workspace-write'; },
      enableWriteAndRetry(chatId) { calls.push({ method: 'retry', chatId }); },
    },
    async () => {},
    async () => {}
  );

  await handler({ message: { from: { id: 123 }, chat: { id: 456 }, text: '/work 30m' } });
  await handler({ callback_query: { id: 'cb1', from: { id: 123 }, message: { chat: { id: 456 } }, data: 'mode:write:retry' } });

  assert.deepEqual(calls, [
    { method: 'work', chatId: 456, minutes: 30 },
    { method: 'retry', chatId: 456 },
  ]);
});

test('command handler supports toggling auto loop', async () => {
  const calls = [];
  const sends = [];
  const handler = createCommandHandler(
    { allowedUserIds: new Set([123]), maxPromptChars: 20000, allowWriteMode: true },
    {
      setAutoLoop(chatId, enabled) {
        calls.push({ chatId, enabled });
        return enabled;
      },
    },
    async (chatId, text) => sends.push({ chatId, text }),
    async () => {}
  );

  await handler({ message: { from: { id: 123 }, chat: { id: 456 }, text: '/autoloop on' } });
  await handler({ callback_query: { id: 'cb1', from: { id: 123 }, message: { chat: { id: 456 } }, data: 'autoloop:off' } });

  assert.deepEqual(calls, [
    { chatId: 456, enabled: true },
    { chatId: 456, enabled: false },
  ]);
  assert.match(sends[0].text, /Auto loop enabled/);
  assert.match(sends[1].text, /Auto loop disabled/);
});

test('smart errors include action buttons for common setup problems', () => {
  const noRepo = buildSmartErrorResponse('No workspace selected. Use /repos first.');
  assert.match(noRepo.text, /Choose a repo/);
  assert.equal(noRepo.options.reply_markup.inline_keyboard[0][0].callback_data, 'repos');

  const trusted = buildSmartErrorResponse('Not inside a trusted directory and --skip-git-repo-check was not specified.');
  assert.match(trusted.text, /trusted/);
  assert.equal(trusted.options.reply_markup.inline_keyboard[0][0].callback_data, 'repos');

  const readOnly = buildSmartErrorResponse('Commit requires confirmed write mode. Use /mode write first.');
  assert.match(readOnly.text, /write/i);
  assert.equal(readOnly.options.reply_markup.inline_keyboard[0][0].callback_data, 'mode:write');
});

test('start shows onboarding repo picker when aliases exist', async () => {
  const sends = [];
  const handler = createCommandHandler(
    {
      allowedUserIds: new Set([123]),
      maxPromptChars: 20000,
      allowWriteMode: true,
      repoAliases: new Map([['chess', '/repo/chess']]),
    },
    { status() { return { workspace: null, mode: 'read-only', running: false, verbose: false }; } },
    async (chatId, text, options) => sends.push({ chatId, text, options })
  );

  await handler({ message: { from: { id: 123 }, chat: { id: 456 }, text: '/start' } });

  assert.match(sends[0].text, /Step 1/);
  assert.equal(sends[0].options.reply_markup.inline_keyboard[0][0].callback_data, 'repo:chess');
});

test('set-default persists selected repo and callback can continue last task', async () => {
  const calls = [];
  const sends = [];
  const handler = createCommandHandler(
    { allowedUserIds: new Set([123]), maxPromptChars: 20000, allowWriteMode: true, repoAliases: new Map([['chess', '/repo/chess']]) },
    {
      setDefaultWorkspace(chatId, alias) { calls.push({ method: 'default', chatId, alias }); return '/repo/chess'; },
      continueLastTask(chatId) { calls.push({ method: 'continue', chatId }); },
    },
    async (chatId, text) => sends.push({ chatId, text }),
    async () => {}
  );

  await handler({ message: { from: { id: 123 }, chat: { id: 456 }, text: '/set-default chess' } });
  await handler({ callback_query: { id: 'cb1', from: { id: 123 }, message: { chat: { id: 456 } }, data: 'continue' } });

  assert.deepEqual(calls, [
    { method: 'default', chatId: 456, alias: 'chess' },
    { method: 'continue', chatId: 456 },
  ]);
  assert.match(sends[0].text, /Default repo saved/);
});

test('session notifier forwards Telegram options such as inline keyboards', async () => {
  const calls = [];
  const notifier = createSessionNotifier(async (chatId, text, options) => {
    calls.push({ chatId, text, options });
  }, { error() {} });
  const options = { reply_markup: { inline_keyboard: [[{ text: 'Diff', callback_data: 'diff' }]] } };

  notifier(456, 'Task actions:', options);
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.deepEqual(calls, [{ chatId: 456, text: 'Task actions:', options }]);
});

test('intent detection identifies prompts that likely need write access', () => {
  assert.equal(promptNeedsWrite('sửa bug login rồi chạy test'), true);
  assert.equal(promptNeedsWrite('implement board animation'), true);
  assert.equal(promptNeedsWrite('giải thích kiến trúc repo'), false);
});

test('repo profiles parse JSON configuration', () => {
  const profiles = parseRepoProfiles('{"chess":{"testCommand":"flutter test","defaultPrompt":"You are in chess app"}}');
  assert.equal(profiles.get('chess').testCommand, 'flutter test');
  assert.equal(profiles.get('chess').defaultPrompt, 'You are in chess app');
});

test('parseKeyValueMap allows wildcard fallback key', () => {
  const map = parseKeyValueMap('chess=flutter test,*=npm test');

  assert.equal(map.get('chess'), 'flutter test');
  assert.equal(map.get('*'), 'npm test');
});

test('test command detector infers common repo test commands', () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-detect-test-'));
  const nodeRepo = path.join(tempRoot, 'node');
  const flutterRepo = path.join(tempRoot, 'flutter');
  const goRepo = path.join(tempRoot, 'go');
  fs.mkdirSync(nodeRepo);
  fs.mkdirSync(flutterRepo);
  fs.mkdirSync(goRepo);
  fs.writeFileSync(path.join(nodeRepo, 'package.json'), JSON.stringify({ scripts: { test: 'vitest' } }));
  fs.writeFileSync(path.join(nodeRepo, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n');
  fs.writeFileSync(path.join(flutterRepo, 'pubspec.yaml'), 'name: app\ndependencies:\n  flutter:\n    sdk: flutter\n');
  fs.writeFileSync(path.join(goRepo, 'go.mod'), 'module example.com/app\n');

  assert.equal(detectTestCommand(nodeRepo), 'pnpm test');
  assert.equal(detectTestCommand(flutterRepo), 'flutter test');
  assert.equal(detectTestCommand(goRepo), 'go test ./...');
});

test('test command detector ignores npm placeholder script', () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-detect-placeholder-'));
  fs.writeFileSync(path.join(tempRoot, 'package.json'), JSON.stringify({ scripts: { test: 'echo "Error: no test specified" && exit 1' } }));

  assert.equal(detectTestCommand(tempRoot), '');
});

test('verify profiles can target a subdirectory and shell command', () => {
  const profiles = parseVerifyProfiles('{"chess-mobile":{"cwd":"mobile","command":"flutter test","successText":"green"}}');

  assert.equal(profiles.get('chess-mobile').cwd, 'mobile');
  assert.equal(profiles.get('chess-mobile').command, 'flutter test');
  assert.equal(profiles.get('chess-mobile').successText, 'green');
});

test('verify profile resolver uses repo alias profile and workspace-relative cwd', () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-verify-profile-'));
  const config = loadConfig({
    TELEGRAM_BOT_TOKEN: 'token',
    TELEGRAM_ALLOWED_USER_IDS: '123',
    WORKSPACE_ALLOWLIST: tempRoot,
    REPO_ALIASES: `chess=${tempRoot}`,
    VERIFY_PROFILES_JSON: '{"chess":{"cwd":"mobile","command":"flutter test","successText":"All green"}}',
  });
  const session = {
    workspace: tempRoot,
    repoAlias: 'chess',
  };

  const profile = resolveVerifyProfile(config, session, 'default-test');

  assert.equal(profile.name, 'chess');
  assert.equal(profile.command, 'flutter test');
  assert.equal(profile.cwd, path.join(tempRoot, 'mobile'));
  assert.equal(profile.successText, 'All green');
});

test('verify profile resolver auto-detects test command from selected repo', () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-verify-detect-'));
  fs.writeFileSync(path.join(tempRoot, 'package.json'), JSON.stringify({ scripts: { test: 'node test/run.js' } }));
  const config = loadConfig({
    TELEGRAM_BOT_TOKEN: 'token',
    TELEGRAM_ALLOWED_USER_IDS: '123',
    WORKSPACE_ALLOWLIST: tempRoot,
    DEFAULT_WORKSPACE: tempRoot,
  });
  const session = {
    workspace: tempRoot,
    repoAlias: '',
  };

  const profile = resolveVerifyProfile(config, session, 'default-test');

  assert.equal(profile.command, 'npm test');
  assert.equal(profile.cwd, tempRoot);
});

test('verify runner reports queued, started, and finished events', async () => {
  const events = [];
  const runner = createVerifyRunner({
    runJob: async (job) => ({ code: 1, output: `failed ${job.id}` }),
    onEvent: async (event) => {
      events.push(event.type);
    },
  });

  const job = await runner.enqueue({
    id: 'job-1',
    label: 'Flutter Test',
    cwd: '/repo/mobile',
    command: 'flutter test',
  });

  await runner.whenIdle();

  assert.equal(job.id, 'job-1');
  assert.deepEqual(events, ['verify.queued', 'verify.started', 'verify.finished']);
});

test('SessionManager queues prompts while a task is running', () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-queue-'));
  const notices = [];
  const config = loadConfig({
    TELEGRAM_BOT_TOKEN: 'token',
    TELEGRAM_ALLOWED_USER_IDS: '123',
    WORKSPACE_ALLOWLIST: tempRoot,
    DEFAULT_WORKSPACE: tempRoot,
  });
  const manager = new SessionManager(config, (chatId, text) => notices.push({ chatId, text }));
  const session = manager.ensure(1);
  session.running = { kill() {} };

  manager.submitPrompt(1, 'task two');

  assert.equal(session.queue.length, 1);
  assert.match(notices[0].text, /queued/i);
});

test('SessionManager tracks active verify jobs in status output', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-verify-status-'));
  let resolveJob;
  const started = [];
  const config = loadConfig({
    TELEGRAM_BOT_TOKEN: 'token',
    TELEGRAM_ALLOWED_USER_IDS: '123',
    WORKSPACE_ALLOWLIST: tempRoot,
    REPO_ALIASES: `chess=${tempRoot}`,
    VERIFY_PROFILES_JSON: '{"chess":{"cwd":".","command":"flutter test"}}',
  });
  const manager = new SessionManager(config, () => {}, {
    createVerifyRunner: (deps) => createVerifyRunner({
      runJob: async (job) => {
        started.push(job.label);
        return new Promise((resolve) => {
          resolveJob = () => resolve({ code: 0, output: 'ok' });
        });
      },
      onEvent: deps.onEvent,
    }),
  });
  manager.setWorkspace(1, 'chess');

  await manager.enqueueTest(1);
  const statusWhileRunning = manager.status(1);
  resolveJob();
  await manager.whenVerifyIdle();
  const statusAfter = manager.status(1);

  assert.deepEqual(started, ['Test']);
  assert.equal(statusWhileRunning.verifyRunning, true);
  assert.equal(statusWhileRunning.verifyLabel, 'Test');
  assert.equal(statusAfter.verifyRunning, false);
});

test('SessionManager auto asks for write confirmation on write-like prompts', () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-intent-'));
  const notices = [];
  const config = loadConfig({
    TELEGRAM_BOT_TOKEN: 'token',
    TELEGRAM_ALLOWED_USER_IDS: '123',
    WORKSPACE_ALLOWLIST: tempRoot,
    REPO_ALIASES: `chess=${tempRoot}`,
    ALLOW_WRITE_MODE: 'true',
    WRITE_REPO_ALIASES: 'chess',
  });
  const manager = new SessionManager(config, (chatId, text, options) => notices.push({ chatId, text, options }));
  manager.setWorkspace(1, 'chess');

  manager.submitPrompt(1, 'sửa bug login');

  assert.match(notices[0].text, /needs write access/i);
  assert.equal(notices[0].options.reply_markup.inline_keyboard[0][0].callback_data, 'mode:write:retry');
});

test('SessionManager auto loop sends failed verify output back to Codex', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-auto-loop-'));
  const prompts = [];
  const config = loadConfig({
    TELEGRAM_BOT_TOKEN: 'token',
    TELEGRAM_ALLOWED_USER_IDS: '123',
    WORKSPACE_ALLOWLIST: tempRoot,
    REPO_ALIASES: `chess=${tempRoot}`,
    VERIFY_PROFILES_JSON: '{"chess":{"cwd":".","command":"flutter test"}}',
    MAX_AUTO_LOOP_ATTEMPTS: '2',
    AUTO_LOOP_DEFAULT: 'true',
  });
  const manager = new SessionManager(config, () => {}, {
    createVerifyRunner: (deps) => createVerifyRunner({
      runJob: async () => ({ code: 1, output: 'Expected true, got false' }),
      onEvent: deps.onEvent,
    }),
  });
  manager.ask = (chatId, prompt) => prompts.push({ chatId, prompt });
  manager.setWorkspace(1, 'chess');

  await manager.enqueueTest(1);
  await manager.whenVerifyIdle();

  assert.equal(prompts.length, 1);
  assert.match(prompts[0].prompt, /Expected true, got false/);
  assert.equal(manager.status(1).autoLoopAttempts, 1);
});

test('attachment helpers choose largest image and create safe local paths', () => {
  const selected = pickLargestPhoto([
    { file_id: 'small', width: 10, height: 10 },
    { file_id: 'large', width: 40, height: 30 },
  ]);
  const attachmentPath = safeAttachmentPath('/tmp/attachments', 'bad/id', 'photos/pic.png');

  assert.equal(selected.file_id, 'large');
  assert.match(attachmentPath, /\/tmp\/attachments\/.*bad_id\.png$/);
});

test('command handler attaches Telegram photos through attachment handler', async () => {
  const calls = [];
  const sends = [];
  const handler = createCommandHandler(
    { allowedUserIds: new Set([123]), maxPromptChars: 20000 },
    {},
    async (chatId, text) => sends.push({ chatId, text }),
    async () => {},
    async (message, chatId) => {
      calls.push({ chatId, fileId: message.photo[0].file_id });
      return '/tmp/image.jpg';
    }
  );

  await handler({ message: { from: { id: 123 }, chat: { id: 456 }, photo: [{ file_id: 'p1', width: 1, height: 1 }] } });

  assert.deepEqual(calls, [{ chatId: 456, fileId: 'p1' }]);
  assert.match(sends[0].text, /Image attached/);
});

test('command handler blocks messages from non-allowlisted chats', async () => {
  const calls = [];
  const handler = createCommandHandler(
    { allowedUserIds: new Set([123]), allowedChatIds: new Set([999]), maxPromptChars: 20000 },
    { ask() { calls.push('ask'); } },
    async () => {}
  );

  await handler({ message: { from: { id: 123 }, chat: { id: 456 }, text: 'hello' } });

  assert.deepEqual(calls, []);
});

test('health report surfaces key runtime configuration', () => {
  const report = buildHealthReport({
    codexBin: 'codex',
    defaultWorkspace: '/repo/chess',
    repoAliases: new Map([['chess', '/repo/chess']]),
    allowWriteMode: true,
    writeRepoAliases: new Set(['chess']),
    dashboardPort: 0,
  });

  assert.match(report, /codex/);
  assert.match(report, /chess/);
  assert.match(report, /write/);
});

test('cleanupAttachments removes old files and keeps fresh files', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-cleanup-'));
  const oldFile = path.join(dir, 'old.jpg');
  const freshFile = path.join(dir, 'fresh.jpg');
  fs.writeFileSync(oldFile, 'old');
  fs.writeFileSync(freshFile, 'fresh');
  const oldTime = new Date(Date.now() - 10 * 60 * 1000);
  fs.utimesSync(oldFile, oldTime, oldTime);

  const result = cleanupAttachments(dir, 60 * 1000);

  assert.equal(result.deleted, 1);
  assert.equal(fs.existsSync(oldFile), false);
  assert.equal(fs.existsSync(freshFile), true);
});

test('bot commands include main mobile commands', () => {
  const commands = buildBotCommands();
  const names = commands.map((item) => item.command);

  assert.equal(names.includes('health'), true);
  assert.equal(names.includes('logs'), true);
  assert.equal(names.includes('queue'), true);
  assert.equal(names.includes('codex_last'), true);
  assert.equal(names.includes('autoloop'), true);
  assert.equal(names.includes('checks'), true);
  assert.equal(names.includes('rerun_failed'), true);
  assert.equal(names.includes('pr_create'), true);
});

test('audit logger can read recent redacted lines', () => {
  const auditPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-audit-')), 'audit.jsonl');
  const logger = new AuditLogger(auditPath);
  logger.write({ type: 'one', TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN || 'token' });
  logger.write({ type: 'two' });

  const lines = logger.readTail(1);

  assert.equal(lines.length, 1);
  assert.match(lines[0], /"type":"two"/);
});

test('SessionManager can cancel queue and run repo profile commands', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-profile-cmd-'));
  const notices = [];
  const config = loadConfig({
    TELEGRAM_BOT_TOKEN: 'token',
    TELEGRAM_ALLOWED_USER_IDS: '123',
    WORKSPACE_ALLOWLIST: tempRoot,
    REPO_ALIASES: `chess=${tempRoot}`,
    REPO_PROFILES_JSON: '{"chess":{"commands":{"Analyze":"printf ok"}}}',
  });
  const manager = new SessionManager(config, (chatId, text) => notices.push({ chatId, text }));
  manager.setWorkspace(1, 'chess');
  const session = manager.ensure(1);
  session.queue.push({ prompt: 'one' }, { prompt: 'two' });

  assert.equal(manager.cancelQueue(1), 2);
  await manager.runProfileCommand(1, 'Analyze');

  assert.equal(session.queue.length, 0);
  assert.equal(notices.some((notice) => /Profile command/.test(notice.text)), true);
});

test('SessionManager can hand the last verify output back to Codex', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-verify-loop-'));
  const notices = [];
  const prompts = [];
  const config = loadConfig({
    TELEGRAM_BOT_TOKEN: 'token',
    TELEGRAM_ALLOWED_USER_IDS: '123',
    WORKSPACE_ALLOWLIST: tempRoot,
    REPO_ALIASES: `mobile=${tempRoot}`,
    REPO_PROFILES_JSON: '{"mobile":{"commands":{"Flutter Test":"printf flutter-failed && exit 1"}}}',
  });
  const manager = new SessionManager(config, (chatId, text, options) => notices.push({ chatId, text, options }));
  manager.ask = (chatId, prompt) => prompts.push({ chatId, prompt });
  manager.setWorkspace(1, 'mobile');

  await manager.runProfileCommand(1, 'Flutter Test');
  manager.submitLastCommandOutputToCodex(1);

  const resultNotice = notices.find((notice) => /Profile command: Flutter Test exit 1/.test(notice.text));
  assert.equal(resultNotice.options.reply_markup.inline_keyboard[0][0].callback_data, 'codex:last-output');
  assert.equal(prompts.length, 1);
  assert.match(prompts[0].prompt, /Last verification command/);
  assert.match(prompts[0].prompt, /Flutter Test/);
  assert.match(prompts[0].prompt, /flutter-failed/);
});

test('command handler supports sending last verify output to Codex', async () => {
  const calls = [];
  const handler = createCommandHandler(
    { allowedUserIds: new Set([123]), maxPromptChars: 20000, allowWriteMode: true },
    {
      submitLastCommandOutputToCodex(chatId) { calls.push({ method: 'last-output', chatId }); },
    },
    async () => {},
    async () => {}
  );

  await handler({ message: { from: { id: 123 }, chat: { id: 456 }, text: '/codex-last' } });
  await handler({ callback_query: { id: 'cb1', from: { id: 123 }, message: { chat: { id: 456 } }, data: 'codex:last-output' } });

  assert.deepEqual(calls, [
    { method: 'last-output', chatId: 456 },
    { method: 'last-output', chatId: 456 },
  ]);
});


test('command handler routes review summary plan fix-last branch and pr-ready', async () => {
  const calls = [];
  const handler = createCommandHandler(
    { allowedUserIds: new Set([123]), maxPromptChars: 20000, allowWriteMode: true },
    {
      review(chatId) { calls.push(['review', chatId]); },
      async summary(chatId) { calls.push(['summary', chatId]); },
      plan(chatId, task) { calls.push(['plan', chatId, task]); },
      submitLastCommandOutputToCodex(chatId) { calls.push(['fix-last', chatId]); },
      async branch(chatId, name) { calls.push(['branch', chatId, name]); },
      async prReady(chatId) { calls.push(['pr-ready', chatId]); },
      async checks(chatId) { calls.push(['checks', chatId]); },
      async rerunFailed(chatId) { calls.push(['rerun-failed', chatId]); },
      async prCreate(chatId) { calls.push(['pr-create', chatId]); },
    },
    async () => {},
    async () => {}
  );

  await handler({ message: { from: { id: 123 }, chat: { id: 456 }, text: '/review' } });
  await handler({ message: { from: { id: 123 }, chat: { id: 456 }, text: '/summary' } });
  await handler({ message: { from: { id: 123 }, chat: { id: 456 }, text: '/plan fix bug' } });
  await handler({ message: { from: { id: 123 }, chat: { id: 456 }, text: '/fix-last' } });
  await handler({ message: { from: { id: 123 }, chat: { id: 456 }, text: '/branch feature/x' } });
  await handler({ message: { from: { id: 123 }, chat: { id: 456 }, text: '/pr-ready' } });
  await handler({ message: { from: { id: 123 }, chat: { id: 456 }, text: '/checks' } });
  await handler({ message: { from: { id: 123 }, chat: { id: 456 }, text: '/rerun-failed' } });
  await handler({ message: { from: { id: 123 }, chat: { id: 456 }, text: '/pr-create' } });

  assert.deepEqual(calls, [
    ['review', 456],
    ['summary', 456],
    ['plan', 456, 'fix bug'],
    ['fix-last', 456],
    ['branch', 456, 'feature/x'],
    ['pr-ready', 456],
    ['checks', 456],
    ['rerun-failed', 456],
    ['pr-create', 456],
  ]);
});

test('SessionManager optional CI helpers are profile-driven with local fallbacks', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-ci-helpers-'));
  const notices = [];
  const jobs = [];
  const config = loadConfig({
    TELEGRAM_BOT_TOKEN: 'token',
    TELEGRAM_ALLOWED_USER_IDS: '123',
    WORKSPACE_ALLOWLIST: tempRoot,
    REPO_ALIASES: `app=${tempRoot}`,
    REPO_PROFILES_JSON: '{"app":{"checksCommand":"npm test","rerunFailedCommand":"npm run retry","prCreateCommand":"gh pr create --fill"}}',
  });
  const manager = new SessionManager(config, (chatId, text) => notices.push({ chatId, text }), {
    runWorkspaceCommand: async () => ({ code: 0, output: 'created pr' }),
  });
  manager.enqueueVerifyJob = async (chatId, fields) => {
    jobs.push({ chatId, fields });
    return fields;
  };
  manager.setWorkspace(1, 'app');

  await manager.checks(1);
  await manager.rerunFailed(1);
  await manager.prCreate(1);

  assert.equal(jobs[0].fields.label, 'Checks');
  assert.equal(jobs[0].fields.command, 'npm test');
  assert.equal(jobs[1].fields.label, 'Rerun failed checks');
  assert.equal(jobs[1].fields.command, 'npm run retry');
  assert.equal(notices.some((notice) => /Create PR exit 0/.test(notice.text)), true);
});

test('SessionManager optional CI helpers explain missing configuration and rerun last failed verify', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-ci-fallback-'));
  const notices = [];
  const jobs = [];
  const config = loadConfig({
    TELEGRAM_BOT_TOKEN: 'token',
    TELEGRAM_ALLOWED_USER_IDS: '123',
    WORKSPACE_ALLOWLIST: tempRoot,
    REPO_ALIASES: `app=${tempRoot}`,
  });
  const manager = new SessionManager(config, (chatId, text) => notices.push({ chatId, text }));
  manager.enqueueVerifyJob = async (chatId, fields) => {
    jobs.push({ chatId, fields });
    return fields;
  };
  manager.setWorkspace(1, 'app');

  await manager.checks(1);
  await manager.prCreate(1);
  manager.ensure(1).lastWorkspaceCommand = {
    label: 'Test',
    command: '/bin/bash -lc npm test',
    rerunCommand: 'npm test',
    cwd: tempRoot,
    code: 1,
    output: 'failed',
  };
  await manager.rerunFailed(1);

  assert.equal(notices.some((notice) => /Checks are not configured/.test(notice.text)), true);
  assert.equal(notices.some((notice) => /PR creation is not configured/.test(notice.text)), true);
  assert.equal(jobs[0].fields.label, 'Rerun failed: Test');
  assert.equal(jobs[0].fields.command, 'npm test');
});

test('SessionManager stores repo notes and prepends them to prompts', () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-notes-'));
  const prompts = [];
  const config = loadConfig({
    TELEGRAM_BOT_TOKEN: 'token',
    TELEGRAM_ALLOWED_USER_IDS: '123',
    WORKSPACE_ALLOWLIST: tempRoot,
    REPO_ALIASES: `app=${tempRoot}`,
    REPO_PROFILES_JSON: '{"app":{"notesPath":".codex-telegram/context.md"}}',
  });
  const manager = new SessionManager(config, () => {});
  manager.setWorkspace(1, 'app');
  manager.addNote(1, 'app này dùng Riverpod');
  manager.ask = (chatId, prompt) => prompts.push({ chatId, prompt: manager.applyPromptContext(manager.ensure(chatId), prompt) });

  manager.submitPrompt(1, 'review architecture');

  assert.match(readRepoNotes(manager.ensure(1), { notesPath: '.codex-telegram/context.md' }), /Riverpod/);
  assert.match(prompts[0].prompt, /Repo memory notes/);
  assert.match(prompts[0].prompt, /Riverpod/);
});

test('SessionManager plan approval stores pending state and reruns task', () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-plan-'));
  const prompts = [];
  const config = loadConfig({
    TELEGRAM_BOT_TOKEN: 'token',
    TELEGRAM_ALLOWED_USER_IDS: '123',
    WORKSPACE_ALLOWLIST: tempRoot,
    REPO_ALIASES: `app=${tempRoot}`,
  });
  const manager = new SessionManager(config, () => {});
  manager.ask = (chatId, prompt, options) => prompts.push({ chatId, prompt, options });
  manager.setWorkspace(1, 'app');

  manager.plan(1, 'implement login');
  assert.equal(manager.status(1).pendingPlan, true);
  assert.equal(prompts[0].options.sandboxMode, 'read-only');
  manager.approvePlan(1);

  assert.equal(manager.status(1).pendingPlan, false);
  assert.equal(prompts[1].prompt, 'implement login');
});

test('SessionManager review and pr-ready use read-only Codex prompts', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-pr-ready-'));
  const prompts = [];
  const config = loadConfig({
    TELEGRAM_BOT_TOKEN: 'token',
    TELEGRAM_ALLOWED_USER_IDS: '123',
    WORKSPACE_ALLOWLIST: tempRoot,
    REPO_ALIASES: `app=${tempRoot}`,
  });
  const manager = new SessionManager(config, () => {}, {
    runWorkspaceCommand: async () => ({ code: 0, output: 'M src/app.js\nabc123 last commit' }),
  });
  manager.ask = (chatId, prompt, options) => prompts.push({ chatId, prompt, options });
  manager.setWorkspace(1, 'app');

  manager.review(1);
  await manager.prReady(1);

  assert.equal(prompts[0].options.sandboxMode, 'read-only');
  assert.match(prompts[0].prompt, /Review the current git diff/);
  assert.equal(prompts[1].options.sandboxMode, 'read-only');
  assert.match(prompts[1].prompt, /ready-for-PR summary/);
});

test('command handler prompts for image-only intent and passes text-plus-image through', async () => {
  const calls = [];
  const sends = [];
  const handler = createCommandHandler(
    { allowedUserIds: new Set([123]), maxPromptChars: 20000 },
    { submitPrompt(chatId, prompt) { calls.push({ chatId, prompt }); } },
    async (chatId, text, options) => sends.push({ chatId, text, options }),
    async () => {},
    async () => '/tmp/image.jpg'
  );

  await handler({ message: { from: { id: 123 }, chat: { id: 456 }, photo: [{ file_id: 'p1', width: 1, height: 1 }] } });
  await handler({ message: { from: { id: 123 }, chat: { id: 456 }, text: 'make this screen', photo: [{ file_id: 'p2', width: 1, height: 1 }] } });
  await handler({ callback_query: { id: 'cb1', from: { id: 123 }, message: { chat: { id: 456 } }, data: 'image-intent:review-ui' } });

  assert.match(sends[0].text, /What should Codex do/);
  assert.equal(sends[0].options.reply_markup.inline_keyboard[0][0].callback_data, 'image-intent:review-ui');
  assert.equal(calls[0].prompt, 'make this screen');
  assert.match(calls[1].prompt, /Review the attached UI screenshot/);
});

test('main keyboard prefers active repo profile commands', () => {
  const keyboard = require('../src/commands').mainKeyboard(
    { allowWriteMode: true, repoProfiles: new Map([
      ['app', { commands: { Analyze: 'flutter analyze', Test: 'flutter test' } }],
      ['api', { commands: { Compile: './gradlew compileJava' } }],
    ]) },
    { status() { return { repoAlias: 'app' }; } },
    1
  );
  const flattened = [].concat.apply([], keyboard.reply_markup.inline_keyboard).map((button) => button.text);

  assert.equal(flattened.includes('Analyze'), true);
  assert.equal(flattened.includes('Compile'), false);
});


test('pr-ready workspace command shell headings do not trip printf option parsing', () => {
  const spec = buildPrReadyCommand(process.cwd());
  const result = spawnSync(spec.command, spec.args, { cwd: spec.cwd, encoding: 'utf8' });

  assert.equal(result.status, 0);
  assert.match(result.stdout, /--- diff stat ---/);
  assert.equal(result.stderr.includes('printf: --'), false);
});

test('repo notes reject symlink escapes before writing', () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-notes-escape-'));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-notes-outside-'));
  fs.symlinkSync(outside, path.join(tempRoot, '.codex-telegram'));
  const config = loadConfig({
    TELEGRAM_BOT_TOKEN: 'token',
    TELEGRAM_ALLOWED_USER_IDS: '123',
    WORKSPACE_ALLOWLIST: tempRoot,
    REPO_ALIASES: `app=${tempRoot}`,
  });
  const manager = new SessionManager(config, () => {});
  manager.setWorkspace(1, 'app');

  assert.throws(() => manager.addNote(1, 'do not escape'), /notesPath escapes workspace/);
  assert.equal(fs.existsSync(path.join(outside, 'context.md')), false);
});

test('profile cwd rejects symlink escapes for verify and profile commands', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-cwd-escape-'));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-cwd-outside-'));
  fs.symlinkSync(outside, path.join(tempRoot, 'mobile'));
  const config = loadConfig({
    TELEGRAM_BOT_TOKEN: 'token',
    TELEGRAM_ALLOWED_USER_IDS: '123',
    WORKSPACE_ALLOWLIST: tempRoot,
    REPO_ALIASES: `app=${tempRoot}`,
    REPO_PROFILES_JSON: '{"app":{"cwd":"mobile","testCommand":"npm test","commands":{"Analyze":"npm test"}}}',
  });
  const manager = new SessionManager(config, () => {}, {
    runWorkspaceCommand: async () => ({ code: 0, output: 'should not run' }),
  });
  manager.setWorkspace(1, 'app');

  assert.throws(() => resolveVerifyProfile(config, manager.ensure(1)), /Profile cwd escapes workspace/);
  await assert.rejects(() => manager.runProfileCommand(1, 'Analyze'), /Profile cwd escapes workspace/);
});

test('non-plan Codex runs do not overwrite pending plan actions', () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-plan-state-'));
  const notices = [];
  let child;
  const config = loadConfig({
    TELEGRAM_BOT_TOKEN: 'token',
    TELEGRAM_ALLOWED_USER_IDS: '123',
    WORKSPACE_ALLOWLIST: tempRoot,
    REPO_ALIASES: `app=${tempRoot}`,
    HEARTBEAT_MS: '0',
  });
  const manager = new SessionManager(config, (chatId, text, options) => notices.push({ chatId, text, options }), {
    runCodexOnce: () => {
      child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.stdin = { write() {}, end() {} };
      child.kill = () => {};
      return child;
    },
  });
  manager.setWorkspace(1, 'app');
  const session = manager.ensure(1);
  session.pendingPlanPrompt = 'original task';
  session.lastAssistantText = 'previous plan';

  manager.ask(1, 'Review the current diff', { sandboxMode: 'read-only', auditType: 'review.started' });
  child.emit('close', 0, null);

  assert.equal(notices.some((notice) => notice.text === 'Plan actions:'), false);
  assert.equal(session.pendingPlanText, '');
});

test('attached images are consumed by exactly one Codex prompt', () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-image-once-'));
  const runs = [];
  const config = loadConfig({
    TELEGRAM_BOT_TOKEN: 'token',
    TELEGRAM_ALLOWED_USER_IDS: '123',
    WORKSPACE_ALLOWLIST: tempRoot,
    REPO_ALIASES: `app=${tempRoot}`,
    HEARTBEAT_MS: '0',
  });
  const manager = new SessionManager(config, () => {}, {
    runCodexOnce: (options) => {
      runs.push(options);
      const child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.stdin = { write() {}, end() {} };
      child.kill = () => {};
      return child;
    },
  });
  manager.setWorkspace(1, 'app');
  manager.attachImages(1, ['/tmp/one.png']);

  manager.ask(1, 'describe image');

  assert.deepEqual(runs[0].imagePaths, ['/tmp/one.png']);
  assert.deepEqual(manager.ensure(1).pendingImagePaths, []);
});

let failures = 0;

(async () => {
  for (const item of tests) {
    try {
      await item.fn();
      console.log(`ok - ${item.name}`);
    } catch (error) {
      failures += 1;
      console.error(`not ok - ${item.name}`);
      console.error(error.stack || error.message);
    }
  }

  if (failures > 0) {
    console.error(`${failures}/${tests.length} tests failed`);
    process.exit(1);
  }

  console.log(`${tests.length}/${tests.length} tests passed`);
})();
