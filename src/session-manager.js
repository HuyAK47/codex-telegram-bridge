'use strict';

const { extractCodexEventInfo, formatCodexJsonLine, redactOutput, runCodexOnce } = require('./codex');
const { resolveAllowedWorkspace, validateTelegramText } = require('./security');
const { AuditLogger } = require('./audit');
const { StateStore } = require('./state-store');
const { promptNeedsWrite } = require('./intent');
const { getRepoProfile } = require('./repo-profiles');
const {
  buildDiffCommand,
  buildFilesCommand,
  buildTestCommand,
  buildCommitCommand,
  runWorkspaceCommand,
} = require('./workspace-tools');

class SessionManager {
  constructor(config, notifier) {
    this.config = config;
    this.notifier = notifier;
    this.sessions = new Map();
    this.audit = new AuditLogger(config.auditLogPath);
    this.stateStore = new StateStore(config.sessionStatePath);
  }

  ensure(chatId) {
    const key = String(chatId);
    if (!this.sessions.has(key)) {
      const restored = this.stateStore.loadSession(key);
      this.sessions.set(key, {
        workspace: restored && restored.workspace ? restored.workspace : this.config.defaultWorkspace,
        running: null,
        mode: 'read-only',
        verbose: restored ? restored.verbose : this.config.codexShowCommandEvents,
        repoAlias: restored && restored.repoAlias ? restored.repoAlias : findAliasForWorkspace(this.config, this.config.defaultWorkspace),
        codexThreadId: restored && restored.codexThreadId ? restored.codexThreadId : '',
        lastAssistantText: '',
        writeExpiresAt: 0,
        pendingCommitMessage: '',
        lastPrompt: '',
        queue: [],
        heartbeatTimer: null,
        startedAt: 0,
      });
    }
    return this.sessions.get(key);
  }

  setWorkspace(chatId, value) {
    const session = this.ensure(chatId);
    const requested = this.config.repoAliases.get(value) || value;
    const newWorkspace = resolveAllowedWorkspace(requested, this.config.allowlistRoots);
    if (session.workspace !== newWorkspace) {
      session.workspace = newWorkspace;
      session.codexThreadId = '';
    }
    session.repoAlias = this.config.repoAliases.has(value) ? value : findAliasForWorkspace(this.config, session.workspace);
    session.mode = 'read-only';
    session.writeExpiresAt = 0;
    this.persist(chatId, session);
    this.audit.write({ type: 'repo.selected', chatId, workspace: session.workspace, repoAlias: session.repoAlias });
    return session.workspace;
  }

  setDefaultWorkspace(chatId, value) {
    const workspace = this.setWorkspace(chatId, value);
    const session = this.ensure(chatId);
    this.stateStore.saveDefault(String(chatId), session);
    this.audit.write({ type: 'repo.default.set', chatId, workspace: session.workspace, repoAlias: session.repoAlias });
    return workspace;
  }

  setMode(chatId, mode) {
    if (mode === 'write' && !this.config.allowWriteMode) {
      throw new Error('Write mode is disabled by ALLOW_WRITE_MODE=false');
    }
    if (!/^(read|write)$/.test(mode)) {
      throw new Error('Mode must be read or write');
    }
    const session = this.ensure(chatId);
    const newMode = mode === 'write' ? 'workspace-write' : 'read-only';
    if (session.mode !== newMode) {
      session.mode = newMode;
      session.codexThreadId = '';
    }
    if (session.mode === 'read-only') {
      session.writeExpiresAt = 0;
    }
    this.persist(chatId, session);
    this.audit.write({ type: 'mode.set', chatId, mode: session.mode, workspace: session.workspace });
    return session.mode;
  }

  requestWriteMode(chatId) {
    const session = this.ensure(chatId);
    if (!this.config.allowWriteMode) {
      return false;
    }
    if (this.config.writeRepoAliases.size > 0 && !this.config.writeRepoAliases.has(session.repoAlias)) {
      return false;
    }
    this.audit.write({ type: 'mode.write.requested', chatId, workspace: session.workspace, repoAlias: session.repoAlias });
    return true;
  }

  confirmWriteMode(chatId) {
    if (!this.requestWriteMode(chatId)) {
      throw new Error('Write mode is disabled for this repo or server');
    }
    const session = this.ensure(chatId);
    const newMode = 'workspace-write';
    if (session.mode !== newMode) {
      session.mode = newMode;
      session.codexThreadId = '';
    }
    session.writeExpiresAt = Date.now() + this.config.writeModeTtlMs;
    this.persist(chatId, session);
    this.audit.write({ type: 'mode.write.confirmed', chatId, workspace: session.workspace, expiresAt: session.writeExpiresAt });
    return session.mode;
  }

  refreshMode(session) {
    if (session.mode === 'workspace-write' && session.writeExpiresAt && Date.now() > session.writeExpiresAt) {
      session.mode = 'read-only';
      session.writeExpiresAt = 0;
      session.codexThreadId = '';
    }
  }

  status(chatId) {
    const session = this.ensure(chatId);
    this.refreshMode(session);
    return {
      workspace: session.workspace,
      mode: session.mode,
      running: Boolean(session.running),
      verbose: session.verbose,
      queueLength: session.queue.length,
    };
  }

  stop(chatId) {
    const session = this.ensure(chatId);
    this.refreshMode(session);
    if (!session.running) {
      return false;
    }
    session.running.kill('SIGTERM');
    session.running = null;
    return true;
  }

  ask(chatId, prompt) {
    const session = this.ensure(chatId);
    if (!session.workspace) {
      throw new Error('No workspace selected. Use /repo <alias-or-path> first.');
    }
    if (session.running) {
      throw new Error('A Codex task is already running. Use /stop before starting another.');
    }

    const safePrompt = validateTelegramText(prompt, this.config.maxPromptChars);
    this.recordPromptForRetry(chatId, safePrompt);
    this.audit.write({ type: 'codex.started', chatId, workspace: session.workspace, mode: session.mode, prompt: safePrompt.slice(0, 500) });
    const child = runCodexOnce({
      codexBin: this.config.codexBin,
      workspace: session.workspace,
      sandboxMode: session.mode,
      extraArgs: this.config.codexExtraArgs,
      skipGitRepoCheck: this.config.codexSkipGitRepoCheck,
      resumeLast: this.config.codexResumeLast,
      resumeSessionId: this.config.codexResumeLast ? session.codexThreadId : '',
      imagePaths: session.pendingImagePaths || [],
    });

    session.running = child;
    session.startedAt = Date.now();
    this.startHeartbeat(chatId, session);
    this.notifier(chatId, `▶️ Codex started\nworkspace: ${session.workspace}\nmode: ${session.mode}`);

    let stdoutRemainder = '';
    let stderrBuffer = '';

    child.stdout.on('data', (chunk) => {
      stdoutRemainder += chunk.toString('utf8');
      const lines = stdoutRemainder.split('\n');
      stdoutRemainder = lines.pop();
      for (const line of lines) {
        this.captureCodexEventInfo(chatId, session, line);
        const formatted = redactOutput(formatCodexJsonLine(line, {
          showCommandEvents: session.verbose,
        }));
        if (formatted) {
          this.notifier(chatId, formatted);
        }
      }
    });

    child.stderr.on('data', (chunk) => {
      stderrBuffer += chunk.toString('utf8');
      if (stderrBuffer.length > 2000) {
        stderrBuffer = stderrBuffer.slice(-2000);
      }
    });

    child.on('error', (error) => {
      session.running = null;
      this.stopHeartbeat(session);
      this.notifier(chatId, `❌ Failed to start Codex: ${redactOutput(error.message)}`);
    });

    child.on('close', (code, signal) => {
      this.stopHeartbeat(session);
      if (stdoutRemainder.trim()) {
        this.captureCodexEventInfo(chatId, session, stdoutRemainder);
        const formatted = redactOutput(formatCodexJsonLine(stdoutRemainder, {
          showCommandEvents: session.verbose,
        }));
        if (formatted) {
          this.notifier(chatId, formatted);
        }
      }
      session.running = null;
      this.audit.write({ type: 'codex.finished', chatId, workspace: session.workspace, code, signal });
      const detail = signal ? `signal ${signal}` : `exit ${code}`;
      const stderr = stderrBuffer.trim() ? `\n${redactOutput(stderrBuffer.trim())}` : '';
      this.notifier(chatId, `⏹️ Codex finished: ${detail}${stderr}`);
      this.offerWriteRetryIfReadOnlyDenied(chatId, stderrBuffer);
      if (code === 0 && !signal) {
        this.notifier(chatId, 'Task actions:', taskActionsKeyboard());
      }
      this.runNextQueued(chatId);
    });

    child.stdin.write(`${safePrompt}\n`);
    child.stdin.end();
  }

  submitPrompt(chatId, prompt) {
    const session = this.ensure(chatId);
    if (session.running) {
      session.queue.push({ prompt, imagePaths: session.pendingImagePaths || [] });
      this.notifier(chatId, `Queued task #${session.queue.length}. It will run after the current task finishes.`, queueKeyboard());
      return 'queued';
    }
    if (session.mode === 'read-only' && promptNeedsWrite(prompt) && this.requestWriteMode(chatId)) {
      this.recordPromptForRetry(chatId, prompt);
      this.notifier(chatId, 'This looks like a code-changing task and needs write access. Enable write mode and run it?', {
        reply_markup: {
          inline_keyboard: [[
            { text: 'Enable write & run', callback_data: 'mode:write:retry' },
            { text: 'Run read-only', callback_data: 'run:readonly' },
          ]],
        },
      });
      return 'needs_write';
    }
    this.ask(chatId, this.applyProfilePrompt(session, prompt));
    return 'started';
  }

  applyProfilePrompt(session, prompt) {
    const profile = getRepoProfile(this.config, session.repoAlias || '');
    if (!profile.defaultPrompt) {
      return prompt;
    }
    return `${profile.defaultPrompt}\n\n${prompt}`;
  }

  runNextQueued(chatId) {
    const session = this.ensure(chatId);
    if (session.running || session.queue.length === 0) {
      return false;
    }
    const next = session.queue.shift();
    session.pendingImagePaths = next.imagePaths || [];
    this.notifier(chatId, `▶️ Starting queued task. Remaining queue: ${session.queue.length}`);
    this.submitPrompt(chatId, next.prompt);
    return true;
  }

  cancelQueue(chatId) {
    const session = this.ensure(chatId);
    const count = session.queue.length;
    session.queue = [];
    this.audit.write({ type: 'queue.cancelled', chatId, count });
    return count;
  }

  startHeartbeat(chatId, session) {
    this.stopHeartbeat(session);
    if (!this.config.heartbeatMs || this.config.heartbeatMs <= 0) {
      return;
    }
    session.heartbeatTimer = setInterval(() => {
      const elapsedSeconds = Math.floor((Date.now() - session.startedAt) / 1000);
      this.notifier(chatId, `Still running for ${elapsedSeconds}s`, {
        reply_markup: { inline_keyboard: [[{ text: 'Stop', callback_data: 'stop' }, { text: 'Status', callback_data: 'status' }]] },
      });
    }, this.config.heartbeatMs);
  }

  stopHeartbeat(session) {
    if (session.heartbeatTimer) {
      clearInterval(session.heartbeatTimer);
      session.heartbeatTimer = null;
    }
  }

  setVerbose(chatId, enabled) {
    const session = this.ensure(chatId);
    session.verbose = Boolean(enabled);
    this.persist(chatId, session);
    this.audit.write({ type: 'verbose.set', chatId, enabled: session.verbose });
  }

  reset(chatId) {
    const session = this.ensure(chatId);
    if (session.running) {
      session.running.kill('SIGTERM');
    }
    this.sessions.delete(String(chatId));
    this.audit.write({ type: 'session.reset', chatId });
  }

  recordPromptForRetry(chatId, prompt) {
    const session = this.ensure(chatId);
    session.lastPrompt = validateTelegramText(prompt, this.config.maxPromptChars);
  }

  continueLastTask(chatId) {
    const session = this.ensure(chatId);
    if (!session.lastPrompt) {
      throw new Error('No previous prompt to continue');
    }
    const priorAnswer = session.lastAssistantText ? `\n\nTóm tắt/câu trả lời trước của bạn:\n${session.lastAssistantText}` : '';
    this.submitPrompt(chatId, `Tiếp tục task trước một cách cụ thể, không hỏi lại “1,2,3” nếu chúng đã nằm trong context trước. Prompt trước: ${session.lastPrompt}${priorAnswer}`);
  }

  offerWriteRetryIfReadOnlyDenied(chatId, text) {
    const session = this.ensure(chatId);
    if (session.mode !== 'read-only' || !session.lastPrompt) {
      return false;
    }
    if (!/read-only|readonly|sandbox|permission denied|requires write/i.test(text || '')) {
      return false;
    }
    if (!this.requestWriteMode(chatId)) {
      return false;
    }
    this.notifier(chatId, 'Codex needs write access. Enable write mode and retry the last prompt?', {
      reply_markup: {
        inline_keyboard: [[
          { text: 'Enable write & retry', callback_data: 'mode:write:retry' },
          { text: 'Stay read-only', callback_data: 'mode:read' },
        ]],
      },
    });
    return true;
  }

  enableWriteAndRetry(chatId) {
    const session = this.ensure(chatId);
    const prompt = session.lastPrompt;
    this.confirmWriteMode(chatId);
    if (!prompt) {
      throw new Error('No previous prompt to retry');
    }
    this.submitPrompt(chatId, prompt);
  }

  runReadOnlyLastPrompt(chatId) {
    const session = this.ensure(chatId);
    if (!session.lastPrompt) {
      throw new Error('No previous prompt to run');
    }
    this.ask(chatId, this.applyProfilePrompt(session, session.lastPrompt));
  }

  enableWriteWindow(chatId, minutes) {
    const session = this.ensure(chatId);
    if (!this.requestWriteMode(chatId)) {
      throw new Error('Write mode is disabled for this repo or server');
    }
    const safeMinutes = Math.max(1, Math.min(Number(minutes) || 10, 120));
    session.mode = 'workspace-write';
    session.writeExpiresAt = Date.now() + safeMinutes * 60 * 1000;
    this.persist(chatId, session);
    this.audit.write({ type: 'mode.write.window', chatId, workspace: session.workspace, minutes: safeMinutes });
    return session.mode;
  }

  async diff(chatId) {
    const session = this.requireWorkspace(chatId);
    await this.runAndNotify(chatId, 'Diff', buildDiffCommand(session.workspace));
  }

  async files(chatId) {
    const session = this.requireWorkspace(chatId);
    await this.runAndNotify(chatId, 'Changed files', buildFilesCommand(session.workspace));
  }

  async test(chatId) {
    const session = this.requireWorkspace(chatId);
    const profile = getRepoProfile(this.config, session.repoAlias || '');
    const testCommand = profile.testCommand || this.config.testCommands.get(session.repoAlias || '') || this.config.testCommands.get('*');
    await this.runAndNotify(chatId, 'Test', buildTestCommand(session.workspace, testCommand));
  }

  async runProfileCommand(chatId, name) {
    const session = this.requireWorkspace(chatId);
    const profile = getRepoProfile(this.config, session.repoAlias || '');
    if (!profile.commands || !profile.commands[name]) {
      throw new Error(`No profile command configured: ${name}`);
    }
    await this.runAndNotify(chatId, `Profile command: ${name}`, buildTestCommand(session.workspace, profile.commands[name]));
  }

  auditTail(limit) {
    return this.audit.readTail(limit || 20);
  }

  attachImages(chatId, imagePaths) {
    const session = this.ensure(chatId);
    session.pendingImagePaths = imagePaths || [];
    this.notifier(chatId, `Attached ${session.pendingImagePaths.length} image(s) for the next prompt.`);
  }

  snapshot() {
    const sessions = [];
    for (const entry of this.sessions.entries()) {
      sessions.push({
        chatId: entry[0],
        workspace: entry[1].workspace,
        mode: entry[1].mode,
        running: Boolean(entry[1].running),
        queueLength: entry[1].queue.length,
      });
    }
    return { sessions };
  }

  async requestCommit(chatId, message) {
    const session = this.requireWorkspace(chatId);
    this.refreshMode(session);
    if (session.mode !== 'workspace-write') {
      throw new Error('Commit requires confirmed write mode. Use /mode write first.');
    }
    buildCommitCommand(session.workspace, message);
    session.pendingCommitMessage = message.trim();
    this.audit.write({ type: 'commit.requested', chatId, workspace: session.workspace, message: session.pendingCommitMessage });
    this.notifier(chatId, `⚠️ Confirm commit?\n${session.pendingCommitMessage}`);
  }

  async confirmCommit(chatId) {
    const session = this.requireWorkspace(chatId);
    this.refreshMode(session);
    if (session.mode !== 'workspace-write') {
      throw new Error('Commit requires confirmed write mode. Use /mode write first.');
    }
    if (!session.pendingCommitMessage) {
      throw new Error('No pending commit request');
    }
    const message = session.pendingCommitMessage;
    session.pendingCommitMessage = '';
    await this.runAndNotify(chatId, 'Commit', buildCommitCommand(session.workspace, message));
  }

  cancelCommit(chatId) {
    const session = this.ensure(chatId);
    session.pendingCommitMessage = '';
    this.audit.write({ type: 'commit.cancelled', chatId });
  }

  requireWorkspace(chatId) {
    const session = this.ensure(chatId);
    if (!session.workspace) {
      throw new Error('No workspace selected. Use /repos first.');
    }
    return session;
  }

  async runAndNotify(chatId, label, spec) {
    this.audit.write({ type: 'workspace.command.started', chatId, label, command: spec.command, args: spec.args });
    this.notifier(chatId, `▶️ ${label} started`);
    const result = await runWorkspaceCommand(spec, this.config.workspaceCommandTimeoutMs);
    this.audit.write({ type: 'workspace.command.finished', chatId, label, code: result.code });
    this.notifier(chatId, `${result.code === 0 ? '✅' : '❌'} ${label} exit ${result.code}\n${result.output}`);
  }

  persist(chatId, session) {
    this.stateStore.saveSession(String(chatId), session);
  }

  captureCodexEventInfo(chatId, session, line) {
    const info = extractCodexEventInfo(line);
    if (info.threadId) {
      session.codexThreadId = info.threadId;
      this.persist(chatId, session);
    }
    if (info.assistantText) {
      session.lastAssistantText = info.assistantText;
    }
  }
}

module.exports = { SessionManager };

function findAliasForWorkspace(config, workspace) {
  if (!workspace || !config.repoAliases) {
    return '';
  }
  for (const entry of config.repoAliases.entries()) {
    if (entry[1] === workspace) {
      return entry[0];
    }
  }
  return '';
}

function taskActionsKeyboard() {
  return {
    reply_markup: {
      inline_keyboard: [
        [{ text: 'Continue', callback_data: 'continue' }, { text: 'Work 30m', callback_data: 'work:30' }],
        [{ text: 'Diff', callback_data: 'diff' }, { text: 'Files', callback_data: 'files' }, { text: 'Test', callback_data: 'test' }],
        [{ text: 'Status', callback_data: 'status' }, { text: 'Stop', callback_data: 'stop' }],
      ],
    },
  };
}

function queueKeyboard() {
  return {
    reply_markup: {
      inline_keyboard: [[
        { text: 'Status', callback_data: 'status' },
        { text: 'Stop', callback_data: 'stop' },
      ]],
    },
  };
}
