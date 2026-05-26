'use strict';

const { extractCodexEventInfo, formatCodexJsonLine, redactOutput, runCodexOnce } = require('./codex');
const { resolveAllowedWorkspace, validateTelegramText } = require('./security');
const { AuditLogger } = require('./audit');
const { StateStore } = require('./state-store');
const { promptNeedsWrite } = require('./intent');
const { getRepoProfile } = require('./repo-profiles');
const { createVerifyRunner } = require('./verify-runner');
const { createVerifyJob } = require('./verify-jobs');
const { resolveVerifyProfile } = require('./verify-profiles');
const { appendRepoNote, prependRepoNotes, readRepoNotes } = require('./repo-notes');
const {
  buildDiffCommand,
  buildFilesCommand,
  buildTestCommand,
  buildBranchCommand,
  buildCommitCommand,
  buildPrReadyCommand,
  runWorkspaceCommand,
} = require('./workspace-tools');

class SessionManager {
  constructor(config, notifier, options) {
    this.config = config;
    this.notifier = notifier;
    this.options = options || {};
    this.telegramClient = options && options.telegramClient ? options.telegramClient : null;
    this.runWorkspaceCommand = options && options.runWorkspaceCommand ? options.runWorkspaceCommand : runWorkspaceCommand;
    this.runCodexOnce = options && options.runCodexOnce ? options.runCodexOnce : runCodexOnce;
    this.sessions = new Map();
    this.audit = new AuditLogger(config.auditLogPath);
    this.stateStore = new StateStore(config.sessionStatePath);
    this.verifyRunner = options && options.createVerifyRunner
      ? options.createVerifyRunner({
          runJob: this.executeVerifyJob.bind(this),
          onEvent: this.handleVerifyEvent.bind(this),
        })
      : createVerifyRunner({
          runJob: this.executeVerifyJob.bind(this),
          onEvent: this.handleVerifyEvent.bind(this),
        });
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
        pendingPlanPrompt: '',
        pendingPlanText: '',
        lastPrompt: '',
        lastWorkspaceCommand: null,
        latestVerifyResult: null,
        verifyJob: null,
        verifyQueue: [],
        autoLoopEnabled: this.config.autoLoopDefault,
        autoLoopAttempts: 0,
        pendingVerifyRequest: null,
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
      repoAlias: session.repoAlias,
      mode: session.mode,
      running: Boolean(session.running),
      verbose: session.verbose,
      queueLength: session.queue.length,
      verifyRunning: Boolean(session.verifyJob),
      verifyLabel: session.verifyJob ? session.verifyJob.label : '',
      verifyQueueLength: session.verifyQueue.length,
      autoLoopEnabled: session.autoLoopEnabled,
      autoLoopAttempts: session.autoLoopAttempts,
      workflowState: this.workflowState(session),
      pendingCommit: Boolean(session.pendingCommitMessage),
      pendingPlan: Boolean(session.pendingPlanPrompt),
      lastCommandLabel: session.lastWorkspaceCommand ? session.lastWorkspaceCommand.label : '',
      latestVerifyResult: session.latestVerifyResult,
      repoNotes: this.repoNotesStatus(session),
    };
  }

  workflowState(session) {
    if (session.running) {
      return session.pendingPlanPrompt ? 'planning' : 'coding';
    }
    if (session.pendingCommitMessage) {
      return 'waiting for commit confirmation';
    }
    if (session.pendingPlanPrompt) {
      return 'waiting for plan approval';
    }
    if (session.verifyJob) {
      return 'verifying';
    }
    return 'idle';
  }

  repoNotesStatus(session) {
    if (!session.workspace) {
      return { enabled: false, path: '', hasNotes: false };
    }
    const profile = getRepoProfile(this.config, session.repoAlias || '');
    try {
      const notes = readRepoNotes(session, profile, 1);
      return { enabled: true, path: profile.notesPath || '.codex-telegram/context.md', hasNotes: Boolean(notes) };
    } catch (_error) {
      return { enabled: false, path: '', hasNotes: false };
    }
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

  ask(chatId, prompt, options) {
    const settings = options || {};
    const session = this.ensure(chatId);
    if (!session.workspace) {
      throw new Error('No workspace selected. Use /repo <alias-or-path> first.');
    }
    if (session.running) {
      throw new Error('A Codex task is already running. Use /stop before starting another.');
    }

    const contextPrompt = settings.skipContext ? prompt : this.applyPromptContext(session, prompt);
    const safePrompt = validateTelegramText(contextPrompt, this.config.maxPromptChars);
    if (!settings.skipRetryRecord) {
      this.recordPromptForRetry(chatId, prompt);
    }
    this.prepareAutoVerifyForPrompt(session, prompt);
    const runtimeMode = settings.sandboxMode || session.mode;
    this.audit.write({ type: settings.auditType || 'codex.started', chatId, workspace: session.workspace, mode: runtimeMode, prompt: safePrompt.slice(0, 500) });
    const child = this.runCodexOnce({
      codexBin: this.config.codexBin,
      workspace: session.workspace,
      sandboxMode: runtimeMode,
      extraArgs: this.config.codexExtraArgs,
      skipGitRepoCheck: this.config.codexSkipGitRepoCheck,
      resumeLast: this.config.codexResumeLast,
      resumeSessionId: this.config.codexResumeLast ? session.codexThreadId : '',
      imagePaths: session.pendingImagePaths || [],
    });

    session.pendingImagePaths = [];
    this.persist(chatId, session);
    session.running = child;
    session.startedAt = Date.now();
    this.startHeartbeat(chatId, session);
    this.notifier(chatId, `▶️ Codex started\nworkspace: ${session.workspace}\nmode: ${runtimeMode}`);

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
      if (settings.planMode && session.pendingPlanPrompt && session.lastAssistantText) {
        session.pendingPlanText = session.lastAssistantText;
        this.persist(chatId, session);
        this.notifier(chatId, 'Plan actions:', planActionsKeyboard());
      }
      this.audit.write({ type: settings.finishAuditType || 'codex.finished', chatId, workspace: session.workspace, code, signal });
      const detail = signal ? `signal ${signal}` : `exit ${code}`;
      const stderr = stderrBuffer.trim() ? `\n${redactOutput(stderrBuffer.trim())}` : '';
      this.notifier(chatId, `⏹️ Codex finished: ${detail}${stderr}`);
      this.offerWriteRetryIfReadOnlyDenied(chatId, stderrBuffer);
      if (code === 0 && !signal) {
        this.notifier(chatId, 'Task actions:', taskActionsKeyboard());
        this.maybeRunPendingVerify(chatId, session);
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
    this.ask(chatId, prompt);
    return 'started';
  }

  applyProfilePrompt(session, prompt) {
    const profile = getRepoProfile(this.config, session.repoAlias || '');
    if (!profile.defaultPrompt) {
      return prompt;
    }
    return `${profile.defaultPrompt}\n\n${prompt}`;
  }

  applyPromptContext(session, prompt) {
    const profile = getRepoProfile(this.config, session.repoAlias || '');
    const profiledPrompt = this.applyProfilePrompt(session, prompt);
    const notes = readRepoNotes(session, profile, Math.min(4000, Math.floor(Number(this.config.maxPromptChars || 20000) / 4)));
    return prependRepoNotes(profiledPrompt, notes);
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
      session.running = null;
    }
    session.codexThreadId = '';
    session.lastAssistantText = '';
    session.lastPrompt = '';
    session.queue = [];
    session.pendingPlanPrompt = '';
    session.pendingPlanText = '';
    session.pendingImagePaths = [];
    session.autoLoopAttempts = 0;
    this.persist(chatId, session);
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

  setAutoLoop(chatId, enabled) {
    const session = this.ensure(chatId);
    session.autoLoopEnabled = Boolean(enabled);
    if (!session.autoLoopEnabled) {
      session.pendingVerifyRequest = null;
      session.autoLoopAttempts = 0;
    }
    this.persist(chatId, session);
    return session.autoLoopEnabled;
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
    this.ask(chatId, session.lastPrompt);
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

  async plan(chatId, task) {
    const session = this.requireWorkspace(chatId);
    const safeTask = validateTelegramText(task || session.lastPrompt || '', this.config.maxPromptChars);
    if (!safeTask) {
      throw new Error('Plan task is required');
    }
    session.pendingPlanPrompt = safeTask;
    session.pendingPlanText = '';
    this.persist(chatId, session);
    this.audit.write({ type: 'plan.requested', chatId, workspace: session.workspace, prompt: safeTask.slice(0, 500) });
    this.ask(chatId, [
      'Analyze this task, inspect the relevant code, and propose a concrete implementation plan.',
      'Do not modify files yet. Call out risks, tests, and the smallest safe path.',
      '',
      safeTask,
    ].join('\n'), { sandboxMode: 'read-only', auditType: 'plan.started', finishAuditType: 'plan.finished', planMode: true });
  }

  approvePlan(chatId) {
    const session = this.requireWorkspace(chatId);
    const prompt = session.pendingPlanPrompt;
    if (!prompt) {
      throw new Error('No pending plan to approve');
    }
    session.pendingPlanPrompt = '';
    session.pendingPlanText = '';
    this.persist(chatId, session);
    this.audit.write({ type: 'plan.approved', chatId, workspace: session.workspace });
    this.submitPrompt(chatId, prompt);
  }

  revisePlan(chatId) {
    const session = this.requireWorkspace(chatId);
    if (!session.pendingPlanPrompt) {
      throw new Error('No pending plan to revise');
    }
    this.audit.write({ type: 'plan.revise.requested', chatId, workspace: session.workspace });
    this.ask(chatId, [
      'Revise the previous implementation plan. Keep this as planning only and do not modify files.',
      'Make the plan smaller, safer, and more concrete.',
      '',
      'Task:',
      session.pendingPlanPrompt,
      '',
      'Previous plan:',
      session.pendingPlanText || session.lastAssistantText || '(not captured yet)',
    ].join('\n'), { sandboxMode: 'read-only', auditType: 'plan.revise.started', finishAuditType: 'plan.revise.finished', planMode: true });
  }

  cancelPlan(chatId) {
    const session = this.ensure(chatId);
    session.pendingPlanPrompt = '';
    session.pendingPlanText = '';
    this.persist(chatId, session);
    this.audit.write({ type: 'plan.cancelled', chatId });
  }

  review(chatId) {
    this.audit.write({ type: 'review.requested', chatId });
    this.ask(chatId, 'Review the current git diff in this workspace. Find bugs, regressions, incomplete changes, risky edge cases, and missing tests. Do not modify files.', { sandboxMode: 'read-only', auditType: 'review.started', finishAuditType: 'review.finished' });
  }

  async summary(chatId) {
    const session = this.requireWorkspace(chatId);
    const filesResult = await this.runWorkspaceCommand(buildFilesCommand(session.workspace), this.config.workspaceCommandTimeoutMs);
    const latest = session.latestVerifyResult || session.lastWorkspaceCommand || null;
    const lines = [
      'Task summary',
      '',
      `- what changed: ${session.lastAssistantText ? summarizeLine(session.lastAssistantText) : '(no assistant summary captured)'}`,
      `- current changed files: ${filesResult.output || '(none)'}`,
      `- latest verify result: ${latest ? `${latest.label} exit ${latest.code}` : '(not run)'}`,
      `- remaining risks: ${latest && latest.code !== 0 ? 'verification is failing or incomplete' : 'review manually if changes are broad'}`,
      `- ready to commit: ${latest && latest.code === 0 ? 'likely yes' : 'not yet / unknown'}`,
    ];
    this.audit.write({ type: 'summary.generated', chatId, workspace: session.workspace });
    this.notifier(chatId, lines.join('\n'), summaryKeyboard());
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
    const resolved = resolveVerifyProfile(this.config, session, 'default-test');
    await this.runAndNotify(chatId, 'Test', buildTestCommand(resolved.cwd, resolved.command));
  }

  async enqueueTest(chatId) {
    const session = this.requireWorkspace(chatId);
    const resolved = resolveVerifyProfile(this.config, session, 'default-test');
    return this.enqueueVerifyJob(chatId, {
      label: 'Test',
      cwd: resolved.cwd,
      command: resolved.command,
      successText: resolved.successText,
      sourcePrompt: session.lastPrompt,
    });
  }

  async apk(chatId) {
    const session = this.requireWorkspace(chatId);
    if (session.mode !== 'workspace-write') {
      throw new Error('APK build requires confirmed write mode. Use /mode write first.');
    }
    if (!this.telegramClient || typeof this.telegramClient.sendDocument !== 'function') {
      throw new Error('Telegram document upload is not configured.');
    }
    const fs = require('fs');
    const path = require('path');
    const profile = getRepoProfile(this.config, session.repoAlias || '');
    const command = resolveProfileCommand(profile, ['Build APK', 'APK', 'Flutter APK']) || 'flutter build apk --split-per-abi';
    const cwd = resolveProfileCwd(session.workspace, profile);

    this.notifier(chatId, `▶️ Bắt đầu build APK: ${command}`);
    const result = await this.runWorkspaceCommand(buildTestCommand(cwd, command), 300000);
    session.lastWorkspaceCommand = { label: 'APK', command, code: result.code, output: result.output };
    if (result.code !== 0) {
      this.notifier(chatId, `❌ Build APK thất bại (exit ${result.code}):
${result.output}`);
      return;
    }

    this.notifier(chatId, '✅ Build APK thành công. Đang quét và gửi file APK...');
    const apkDir = path.join(cwd, 'build/app/outputs/flutter-apk');
    if (!fs.existsSync(apkDir)) {
      this.notifier(chatId, '❌ Không tìm thấy thư mục build APK.');
      return;
    }

    const files = fs.readdirSync(apkDir);
    const apkFiles = files.filter((file) => file.endsWith('.apk') && !file.includes('lip-') && file !== 'app.apk');
    if (apkFiles.length === 0) {
      this.notifier(chatId, '❌ Không tìm thấy file APK nào.');
      return;
    }

    for (const file of apkFiles) {
      const filePath = path.join(apkDir, file);
      this.notifier(chatId, `📤 Đang gửi file: ${file}...`);
      try {
        await this.telegramClient.sendDocument(chatId, filePath, { caption: `Flutter APK: ${file}` });
        this.notifier(chatId, `✅ Đã gửi xong: ${file}`);
      } catch (error) {
        this.notifier(chatId, `❌ Gửi file ${file} thất bại: ${redactOutput(error.message)}`);
      }
    }
  }


  async runProfileCommand(chatId, name) {
    const session = this.requireWorkspace(chatId);
    const profile = getRepoProfile(this.config, session.repoAlias || '');
    if (!profile.commands || !profile.commands[name]) {
      throw new Error(`No profile command configured: ${name}`);
    }
    await this.runAndNotify(chatId, `Profile command: ${name}`, buildTestCommand(resolveProfileCwd(session.workspace, profile), profile.commands[name]));
  }

  submitLastCommandOutputToCodex(chatId) {
    const session = this.requireWorkspace(chatId);
    if (!session.lastWorkspaceCommand) {
      throw new Error('No previous verify command output to send to Codex.');
    }
    this.ask(chatId, buildLastCommandPrompt(session.lastWorkspaceCommand, this.config.maxPromptChars));
  }

  async enqueueVerifyCommand(chatId, name) {
    const session = this.requireWorkspace(chatId);
    const profile = getRepoProfile(this.config, session.repoAlias || '');
    if (!profile.commands || !profile.commands[name]) {
      throw new Error(`No profile command configured: ${name}`);
    }
    return this.enqueueVerifyJob(chatId, {
      label: `Profile command: ${name}`,
      cwd: resolveProfileCwd(session.workspace, profile),
      command: profile.commands[name],
      successText: '',
      sourcePrompt: session.lastPrompt,
    });
  }

  addNote(chatId, note) {
    const session = this.requireWorkspace(chatId);
    const profile = getRepoProfile(this.config, session.repoAlias || '');
    const result = appendRepoNote(session, profile, note);
    this.audit.write({ type: 'note.updated', chatId, workspace: session.workspace, path: result.filePath });
    this.notifier(chatId, `📝 Repo note saved:
${result.note}`);
    return result;
  }

  async branch(chatId, name) {
    const session = this.requireWorkspace(chatId);
    this.refreshMode(session);
    if (session.mode !== 'workspace-write') {
      throw new Error('Branch creation requires confirmed write mode. Use /mode write first.');
    }
    this.audit.write({ type: 'branch.requested', chatId, workspace: session.workspace, name });
    await this.runAndNotify(chatId, `Branch: ${name}`, buildBranchCommand(session.workspace, name));
  }

  async prReady(chatId) {
    const session = this.requireWorkspace(chatId);
    const result = await this.runWorkspaceCommand(buildPrReadyCommand(session.workspace), this.config.workspaceCommandTimeoutMs);
    const verify = session.latestVerifyResult || session.lastWorkspaceCommand;
    this.audit.write({ type: 'pr_ready.requested', chatId, workspace: session.workspace });
    this.ask(chatId, [
      'Create a concise ready-for-PR summary from this local workspace state.',
      'Include user-facing summary, tests/verification, changed files, risks, and any follow-up needed.',
      'Do not modify files.',
      '',
      'Workspace state:',
      result.output,
      '',
      'Latest verify:',
      verify ? `${verify.label} exit ${verify.code}\n${String(verify.output || '').slice(-2000)}` : '(not run)',
    ].join('\n'), { sandboxMode: 'read-only', auditType: 'pr_ready.started', finishAuditType: 'pr_ready.finished' });
  }

  async checks(chatId) {
    const session = this.requireWorkspace(chatId);
    const profile = getRepoProfile(this.config, session.repoAlias || '');
    const command = profile.checksCommand || resolveProfileCommand(profile, ['Checks', 'CI Checks', 'PR Checks']);
    this.audit.write({ type: 'checks.requested', chatId, workspace: session.workspace, configured: Boolean(command) });
    if (!command) {
      this.notifier(chatId, [
        'ℹ️ Checks are not configured for this repo.',
        'Use /test or /run <name>, or set REPO_PROFILES_JSON with checksCommand or a "Checks" profile command.',
      ].join('\n'));
      return null;
    }
    return this.enqueueVerifyJob(chatId, {
      label: 'Checks',
      cwd: resolveProfileCwd(session.workspace, profile),
      command,
      successText: '',
      sourcePrompt: session.lastPrompt,
    });
  }

  async rerunFailed(chatId) {
    const session = this.requireWorkspace(chatId);
    const profile = getRepoProfile(this.config, session.repoAlias || '');
    const command = profile.rerunFailedCommand || resolveProfileCommand(profile, ['Rerun Failed', 'Rerun CI', 'Retry Checks']);
    this.audit.write({ type: 'rerun_failed.requested', chatId, workspace: session.workspace, configured: Boolean(command) });
    if (command) {
      return this.enqueueVerifyJob(chatId, {
        label: 'Rerun failed checks',
        cwd: resolveProfileCwd(session.workspace, profile),
        command,
        successText: '',
        sourcePrompt: session.lastPrompt,
      });
    }

    const latest = session.latestVerifyResult || session.lastWorkspaceCommand;
    if (latest && latest.code !== 0 && (latest.rerunCommand || latest.command)) {
      return this.enqueueVerifyJob(chatId, {
        label: `Rerun failed: ${latest.label}`,
        cwd: latest.cwd || resolveProfileCwd(session.workspace, profile),
        command: latest.rerunCommand || latest.command,
        successText: '',
        sourcePrompt: session.lastPrompt,
      });
    }

    this.notifier(chatId, [
      'ℹ️ No failed local verify command to rerun.',
      'Run /test, /checks, or configure rerunFailedCommand in REPO_PROFILES_JSON.',
    ].join('\n'));
    return null;
  }

  async prCreate(chatId) {
    const session = this.requireWorkspace(chatId);
    const profile = getRepoProfile(this.config, session.repoAlias || '');
    const command = profile.prCreateCommand || resolveProfileCommand(profile, ['Create PR', 'PR Create', 'Open PR']);
    this.audit.write({ type: 'pr_create.requested', chatId, workspace: session.workspace, configured: Boolean(command) });
    if (!command) {
      this.notifier(chatId, [
        'ℹ️ PR creation is not configured for this repo.',
        'Use /pr-ready for a PR body draft, or set REPO_PROFILES_JSON with prCreateCommand or a "Create PR" profile command.',
      ].join('\n'));
      return null;
    }
    await this.runAndNotify(chatId, 'Create PR', buildTestCommand(resolveProfileCwd(session.workspace, profile), command));
    return true;
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
        repoAlias: entry[1].repoAlias,
        mode: entry[1].mode,
        running: Boolean(entry[1].running),
        queueLength: entry[1].queue.length,
        verifyRunning: Boolean(entry[1].verifyJob),
        verifyLabel: entry[1].verifyJob ? entry[1].verifyJob.label : '',
        verifyQueueLength: entry[1].verifyQueue.length,
        autoLoopEnabled: entry[1].autoLoopEnabled,
        workflowState: this.workflowState(entry[1]),
        pendingCommit: Boolean(entry[1].pendingCommitMessage),
        pendingPlan: Boolean(entry[1].pendingPlanPrompt),
        lastCommandLabel: entry[1].lastWorkspaceCommand ? entry[1].lastWorkspaceCommand.label : '',
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
    this.notifier(chatId, `⚠️ Confirm commit?\n${session.pendingCommitMessage}`, commitConfirmKeyboard());
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
    const result = await this.runWorkspaceCommand(spec, this.config.workspaceCommandTimeoutMs);
    const session = this.ensure(chatId);
    session.lastWorkspaceCommand = {
      label,
      command: formatCommandSpec(spec),
      rerunCommand: commandForRerun(spec),
      cwd: spec.cwd || session.workspace,
      code: result.code,
      output: result.output,
    };
    this.audit.write({ type: 'workspace.command.finished', chatId, label, code: result.code });
    if (/test|verify|profile command|apk/i.test(label)) {
      session.latestVerifyResult = session.lastWorkspaceCommand;
    }
    this.persist(chatId, session);
    this.notifier(chatId, `${result.code === 0 ? '✅' : '❌'} ${label} exit ${result.code}\n${result.output}`, verifyResultKeyboard());
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

  async enqueueVerifyJob(chatId, fields) {
    const session = this.requireWorkspace(chatId);
    const job = createVerifyJob({
      id: buildVerifyJobId(),
      chatId: chatId,
      label: fields.label,
      repoAlias: session.repoAlias,
      workspace: session.workspace,
      cwd: fields.cwd || session.workspace,
      command: fields.command,
      successText: fields.successText || '',
      sourcePrompt: fields.sourcePrompt || session.lastPrompt,
      attempts: session.autoLoopAttempts,
    });
    await this.verifyRunner.enqueue(job);
    return job;
  }

  whenVerifyIdle() {
    return this.verifyRunner.whenIdle();
  }

  async executeVerifyJob(job) {
    return this.runWorkspaceCommand({
      command: '/bin/bash',
      args: ['-lc', job.command],
      cwd: job.cwd,
    }, this.config.workspaceCommandTimeoutMs);
  }

  async handleVerifyEvent(event) {
    const job = event.job;
    const session = this.ensure(job.chatId);
    if (event.type === 'verify.queued') {
      session.verifyQueue.push({ id: job.id, label: job.label, command: job.command });
      this.persist(job.chatId, session);
      this.notifier(job.chatId, `🧪 Queued verify: ${job.label}`);
      return;
    }
    if (event.type === 'verify.started') {
      session.verifyQueue = session.verifyQueue.filter((item) => item.id !== job.id);
      session.verifyJob = job;
      this.persist(job.chatId, session);
      this.audit.write({ type: 'verify.started', chatId: job.chatId, label: job.label, command: job.command });
      this.notifier(job.chatId, `🧪 Verify started: ${job.label}`);
      return;
    }
    if (event.type === 'verify.finished') {
      session.verifyJob = null;
      session.lastWorkspaceCommand = {
        label: job.label,
        command: job.command,
        rerunCommand: job.command,
        cwd: job.cwd,
        code: event.result.code,
        output: event.result.output,
      };
      session.latestVerifyResult = session.lastWorkspaceCommand;
      this.persist(job.chatId, session);
      this.audit.write({ type: 'verify.finished', chatId: job.chatId, label: job.label, code: event.result.code });
      this.notifier(job.chatId, `${event.result.code === 0 ? '✅' : '❌'} ${job.label} exit ${event.result.code}\n${event.result.output}`, verifyResultKeyboard());
      if (event.result.code === 0) {
        if (job.successText) {
          this.notifier(job.chatId, job.successText);
        }
        session.autoLoopAttempts = 0;
        session.pendingVerifyRequest = null;
        this.persist(job.chatId, session);
        return;
      }
      if (session.autoLoopEnabled && session.autoLoopAttempts < this.config.maxAutoLoopAttempts) {
        session.autoLoopAttempts += 1;
        session.pendingVerifyRequest = {
          label: job.label,
          cwd: job.cwd,
          command: job.command,
          successText: job.successText || '',
        };
        this.persist(job.chatId, session);
        this.ask(job.chatId, buildLastCommandPrompt({
          label: job.label,
          command: job.command,
          code: event.result.code,
          output: event.result.output,
        }, this.config.maxPromptChars));
      }
    }
  }

  prepareAutoVerifyForPrompt(session, prompt) {
    if (!session.autoLoopEnabled) {
      return;
    }
    if (!promptNeedsWrite(prompt)) {
      return;
    }
    session.pendingVerifyRequest = {
      type: 'default-test',
    };
  }

  maybeRunPendingVerify(chatId, session) {
    if (!session.pendingVerifyRequest) {
      return;
    }
    const request = session.pendingVerifyRequest;
    session.pendingVerifyRequest = null;
    this.persist(chatId, session);
    if (request.type === 'default-test') {
      this.enqueueTest(chatId).catch((error) => {
        this.notifier(chatId, `❌ Verify enqueue failed: ${redactOutput(error.message)}`);
      });
      return;
    }
    if (request.command) {
      this.enqueueVerifyJob(chatId, request).catch((error) => {
        this.notifier(chatId, `❌ Verify enqueue failed: ${redactOutput(error.message)}`);
      });
    }
  }
}

module.exports = { SessionManager };

function formatCommandSpec(spec) {
  return [spec.command].concat(spec.args || []).join(' ');
}

function commandForRerun(spec) {
  if (spec.command === '/bin/bash' && spec.args && spec.args[0] === '-lc' && spec.args[1]) {
    return spec.args[1];
  }
  return formatCommandSpec(spec);
}

function verifyResultKeyboard() {
  return {
    reply_markup: {
      inline_keyboard: [[
        { text: 'Send output to Codex', callback_data: 'codex:last-output' },
        { text: 'Continue', callback_data: 'continue' },
      ]],
    },
  };
}

function buildLastCommandPrompt(lastCommand, maxPromptChars) {
  const header = [
    'Last verification command finished. Inspect the output, explain the root cause, and make the smallest safe code change needed. Then ask me to rerun the same bridge verify command.',
    '',
    `Label: ${lastCommand.label}`,
    `Command: ${lastCommand.command}`,
    `Exit code: ${lastCommand.code}`,
    '',
    'Output:',
  ].join('\n');
  const budget = Math.max(1000, Number(maxPromptChars || 20000) - header.length - 100);
  const output = String(lastCommand.output || '').slice(-budget);
  return `${header}\n${output}`;
}

function buildVerifyJobId() {
  return `verify-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

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


function commitConfirmKeyboard() {
  return {
    reply_markup: {
      inline_keyboard: [[
        { text: 'Confirm commit', callback_data: 'commit:confirm' },
        { text: 'Cancel', callback_data: 'commit:cancel' },
      ]],
    },
  };
}

function planActionsKeyboard() {
  return {
    reply_markup: {
      inline_keyboard: [[
        { text: 'Approve & Run', callback_data: 'plan:approve' },
        { text: 'Revise Plan', callback_data: 'plan:revise' },
        { text: 'Cancel', callback_data: 'plan:cancel' },
      ]],
    },
  };
}

function summaryKeyboard() {
  return {
    reply_markup: {
      inline_keyboard: [
        [{ text: 'Review diff', callback_data: 'review' }, { text: 'Test', callback_data: 'test' }],
        [{ text: 'Commit?', callback_data: 'status' }, { text: 'PR ready', callback_data: 'pr-ready' }],
      ],
    },
  };
}

function summarizeLine(text) {
  return String(text || '').replace(/\s+/g, ' ').trim().slice(0, 240) || '(none)';
}

function resolveProfileCommand(profile, names) {
  const commands = profile && profile.commands ? profile.commands : {};
  for (const name of names) {
    if (commands[name]) {
      return commands[name];
    }
  }
  return '';
}

function resolveProfileCwd(workspace, profile) {
  const fs = require('fs');
  const path = require('path');
  if (!profile || !profile.cwd || profile.cwd === '.') {
    return workspace;
  }
  if (path.isAbsolute(profile.cwd)) {
    throw new Error('Profile cwd must be workspace-relative');
  }
  const root = fs.realpathSync(workspace);
  const resolved = path.resolve(root, profile.cwd);
  const lexicalRelative = path.relative(root, resolved);
  if (lexicalRelative.startsWith('..') || path.isAbsolute(lexicalRelative)) {
    throw new Error('Profile cwd escapes workspace');
  }
  if (!fs.existsSync(resolved)) {
    return resolved;
  }
  const realResolved = fs.realpathSync(resolved);
  const realRelative = path.relative(root, realResolved);
  if (realRelative.startsWith('..') || path.isAbsolute(realRelative)) {
    throw new Error('Profile cwd escapes workspace');
  }
  return realResolved;
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
