const assert = require('assert').strict;
const fs = require('fs');
const os = require('os');
const path = require('path');

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
const { buildSmartErrorResponse } = require('../src/smart-errors');
const { createSessionNotifier } = require('../src/notifier');
const { promptNeedsWrite } = require('../src/intent');
const { parseRepoProfiles } = require('../src/repo-profiles');
const { pickLargestPhoto, safeAttachmentPath } = require('../src/attachments');
const { buildHealthReport } = require('../src/health');
const { cleanupAttachments } = require('../src/cleanup');
const { buildBotCommands } = require('../src/bot-commands');
const { AuditLogger } = require('../src/audit');
const {
  buildDiffCommand,
  buildFilesCommand,
  buildTestCommand,
  buildCommitCommand,
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
    { status() { return { workspace: '/repo/chess', mode: 'read-only', running: false, verbose: false }; } },
    async (chatId, text, options) => sends.push({ chatId, text, options })
  );

  await handler({ message: { from: { id: 123 }, chat: { id: 456 }, text: '/start' } });
  await handler({ message: { from: { id: 123 }, chat: { id: 456 }, text: '/status' } });

  assert.equal(sends.length, 2);
  assert.ok(sends[0].options.reply_markup.inline_keyboard.length > 0);
  assert.ok(sends[1].options.reply_markup.inline_keyboard.length > 0);
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
  assert.throws(() => buildCommitCommand('/repo', 'bad\nmessage'), /single line/);
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
  const manager = new SessionManager(config, (chatId, text) => notices.push({ chatId, text }));

  manager.setWorkspace(1, 'allowed');
  assert.rejects(() => manager.requestCommit(1, 'safe message'), /requires confirmed write mode/);
  manager.confirmWriteMode(1);
  await manager.requestCommit(1, 'safe message');
  assert.match(notices[0].text, /Confirm commit/);
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
