'use strict';

const { validateTelegramText } = require('./security');
const { buildHealthReport } = require('./health');
const { cleanupAttachments } = require('./cleanup');

function createCommandHandler(config, sessionManager, send, answerCallback, attachmentHandler) {
  return async function handleUpdate(update) {
    if (update.callback_query) {
      await handleCallback(update.callback_query, config, sessionManager, send, answerCallback || noop);
      return;
    }

    const message = update.message;
    if (!message || !message.from || !message.chat) {
      return;
    }

    if (!config.allowedUserIds.has(Number(message.from.id))) {
      console.warn(`blocked Telegram user ${message.from.id}`);
      return;
    }
    if (config.allowedChatIds && config.allowedChatIds.size > 0 && !config.allowedChatIds.has(Number(message.chat.id))) {
      console.warn(`blocked Telegram chat ${message.chat.id}`);
      return;
    }

    const chatId = message.chat.id;
    const rawText = message.text || message.caption || '';
    if (message.photo && message.photo.length > 0) {
      if (!attachmentHandler) {
        await send(chatId, 'Image received, but attachment handling is not enabled.');
        return;
      }
      const attachmentPath = await attachmentHandler(message, chatId);
      if (!rawText) {
        await send(chatId, `✅ Image attached. What should Codex do?\n${attachmentPath}`, imageIntentKeyboard());
        return;
      }
    }

    const text = validateTelegramText(rawText, config.maxPromptChars);
    if (!text) {
      await send(chatId, 'Send text only. Files/images are intentionally disabled in this MVP.');
      return;
    }

    if (text === '/start' || text === '/help') {
      await send(chatId, onboardingText(config, sessionManager, chatId), onboardingKeyboard(config));
      return;
    }

    if (text === '/repos') {
      await send(chatId, repoListText(config), repoKeyboard(config));
      return;
    }

    if (text.startsWith('/repo ')) {
      const workspace = sessionManager.setWorkspace(chatId, text.slice('/repo '.length).trim());
      await send(chatId, `✅ Workspace selected:\n${workspace}`);
      return;
    }

    if (text.startsWith('/set-default ') || text.startsWith('/set_default ')) {
      const isUnderscore = text.startsWith('/set_default ');
      const prefixLength = isUnderscore ? '/set_default '.length : '/set-default '.length;
      const workspace = sessionManager.setDefaultWorkspace(chatId, text.slice(prefixLength).trim());
      await send(chatId, `✅ Default repo saved:\n${workspace}`);
      return;
    }

    if (text === '/status') {
      const status = sessionManager.status(chatId);
      await send(
        chatId,
        statusText(status),
        mainKeyboard(config, sessionManager, chatId)
      );
      return;
    }

    if (text === '/stop') {
      const stopped = sessionManager.stop(chatId);
      await send(chatId, stopped ? '🛑 Stop signal sent.' : 'No Codex task is running.');
      return;
    }

    if (text === '/mode read') {
      const mode = sessionManager.setMode(chatId, 'read');
      await send(chatId, `✅ Mode set to ${mode}`);
      return;
    }

    if (text === '/mode write') {
      await requestWriteMode(chatId, config, sessionManager, send);
      return;
    }

    if (text.startsWith('/work ')) {
      const minutes = parseWorkMinutes(text.slice('/work '.length));
      const mode = sessionManager.enableWriteWindow(chatId, minutes);
      await send(chatId, `⚠️ Mode set to ${mode} for ${minutes} minutes.`);
      return;
    }

    if (text === '/autoloop on') {
      sessionManager.setAutoLoop(chatId, true);
      await send(chatId, '✅ Auto loop enabled.');
      return;
    }

    if (text === '/autoloop off') {
      sessionManager.setAutoLoop(chatId, false);
      await send(chatId, '✅ Auto loop disabled.');
      return;
    }

    if (text === '/continue') {
      sessionManager.continueLastTask(chatId);
      return;
    }

    if (text === '/queue') {
      const status = sessionManager.status(chatId);
      await send(chatId, `queue: ${status.queueLength || 0}`, queueKeyboard());
      return;
    }

    if (text === '/cancel-queue' || text === '/cancel_queue') {
      const cancelled = sessionManager.cancelQueue(chatId);
      await send(chatId, `Cancelled ${cancelled} queued task(s).`);
      return;
    }

    if (text === '/health') {
      await send(chatId, buildHealthReport(config), mainKeyboard(config, sessionManager, chatId));
      return;
    }

    if (text === '/logs') {
      await send(chatId, sessionManager.auditTail(20).join('\n') || '(no audit logs)');
      return;
    }

    if (text === '/cleanup') {
      const result = cleanupAttachments(config.attachmentDir, config.attachmentMaxAgeMs);
      await send(chatId, `Cleanup scanned ${result.scanned}, deleted ${result.deleted}.`);
      return;
    }

    if (text.startsWith('/run ')) {
      if (sessionManager.enqueueVerifyCommand) {
        await sessionManager.enqueueVerifyCommand(chatId, text.slice('/run '.length).trim());
      } else {
        await sessionManager.runProfileCommand(chatId, text.slice('/run '.length).trim());
      }
      return;
    }

    if (text === '/diff') {
      await sessionManager.diff(chatId);
      return;
    }

    if (text === '/files') {
      await sessionManager.files(chatId);
      return;
    }

    if (text === '/test') {
      if (sessionManager.enqueueTest) {
        await sessionManager.enqueueTest(chatId);
      } else {
        await sessionManager.test(chatId);
      }
      return;
    }

    if (text === '/apk') {
      await sessionManager.apk(chatId);
      return;
    }

    if (text === '/codex-last' || text === '/codex_last' || text === '/fix-last' || text === '/fix_last') {
      sessionManager.submitLastCommandOutputToCodex(chatId);
      return;
    }

    if (text.startsWith('/plan ')) {
      sessionManager.plan(chatId, text.slice('/plan '.length));
      return;
    }

    if (text === '/review') {
      sessionManager.review(chatId);
      return;
    }

    if (text === '/summary' || text === '/done') {
      await sessionManager.summary(chatId);
      return;
    }

    if (text.startsWith('/note ')) {
      sessionManager.addNote(chatId, text.slice('/note '.length));
      return;
    }

    if (text.startsWith('/branch ')) {
      await sessionManager.branch(chatId, text.slice('/branch '.length));
      return;
    }

    if (text === '/pr-ready' || text === '/pr_ready') {
      await sessionManager.prReady(chatId);
      return;
    }

    if (text.startsWith('/commit ')) {
      await sessionManager.requestCommit(chatId, text.slice('/commit '.length));
      return;
    }

    if (text === '/verbose on') {
      sessionManager.setVerbose(chatId, true);
      await send(chatId, '✅ Verbose command events enabled.');
      return;
    }

    if (text === '/verbose off') {
      sessionManager.setVerbose(chatId, false);
      await send(chatId, '✅ Verbose command events disabled.');
      return;
    }

    if (text === '/reset-task' || text === '/reset_task') {
      sessionManager.reset(chatId);
      await send(chatId, '✅ Session reset.');
      return;
    }

    if (text.startsWith('/ask ')) {
      submitPrompt(sessionManager, chatId, text.slice('/ask '.length));
      return;
    }

    if (!text.startsWith('/')) {
      submitPrompt(sessionManager, chatId, text);
      return;
    }

    await send(chatId, 'Unknown command. Send a normal message to ask Codex, or use /help.');
  };
}

async function handleCallback(callbackQuery, config, sessionManager, send, answerCallback) {
  if (!config.allowedUserIds.has(Number(callbackQuery.from.id))) {
    console.warn(`blocked Telegram callback user ${callbackQuery.from.id}`);
    return;
  }

  const chatId = callbackQuery.message && callbackQuery.message.chat && callbackQuery.message.chat.id;
  if (config.allowedChatIds && config.allowedChatIds.size > 0 && !config.allowedChatIds.has(Number(chatId))) {
    console.warn(`blocked Telegram callback chat ${chatId}`);
    return;
  }
  const data = callbackQuery.data || '';
  await answerCallback(callbackQuery.id, 'OK');

  if (data.startsWith('repo:')) {
    const workspace = sessionManager.setWorkspace(chatId, data.slice('repo:'.length));
    await send(chatId, `✅ Workspace selected:\n${workspace}`);
    return;
  }
  if (data === 'repos') {
    await send(chatId, repoListText(config), repoKeyboard(config));
    return;
  }
  if (data === 'status') {
    await send(chatId, statusText(sessionManager.status(chatId)), mainKeyboard(config, sessionManager, chatId));
    return;
  }
  if (data === 'stop') {
    const stopped = sessionManager.stop(chatId);
    await send(chatId, stopped ? '🛑 Stop signal sent.' : 'No Codex task is running.');
    return;
  }
  if (data === 'mode:read') {
    const mode = sessionManager.setMode(chatId, 'read');
    await send(chatId, `✅ Mode set to ${mode}`);
    return;
  }
  if (data === 'mode:write') {
    await requestWriteMode(chatId, config, sessionManager, send);
    return;
  }
  if (data === 'mode:write:confirm') {
    const mode = sessionManager.confirmWriteMode(chatId);
    await send(chatId, `⚠️ Mode set to ${mode}. Write mode will auto-expire.`);
    return;
  }
  if (data === 'mode:write:retry') {
    sessionManager.enableWriteAndRetry(chatId);
    return;
  }
  if (data === 'autoloop:on') {
    sessionManager.setAutoLoop(chatId, true);
    await send(chatId, '✅ Auto loop enabled.');
    return;
  }
  if (data === 'autoloop:off') {
    sessionManager.setAutoLoop(chatId, false);
    await send(chatId, '✅ Auto loop disabled.');
    return;
  }
  if (data === 'run:readonly') {
    sessionManager.runReadOnlyLastPrompt(chatId);
    return;
  }
  if (data.startsWith('work:')) {
    const minutes = parseWorkMinutes(data.slice('work:'.length));
    const mode = sessionManager.enableWriteWindow(chatId, minutes);
    await send(chatId, `⚠️ Mode set to ${mode} for ${minutes} minutes.`);
    return;
  }
  if (data === 'continue') {
    sessionManager.continueLastTask(chatId);
    return;
  }
  if (data === 'queue') {
    const status = sessionManager.status(chatId);
    await send(chatId, `queue: ${status.queueLength || 0}`, queueKeyboard());
    return;
  }
  if (data === 'cancel-queue') {
    const cancelled = sessionManager.cancelQueue(chatId);
    await send(chatId, `Cancelled ${cancelled} queued task(s).`);
    return;
  }
  if (data === 'health') {
    await send(chatId, buildHealthReport(config), mainKeyboard(config, sessionManager, chatId));
    return;
  }
  if (data.startsWith('run:')) {
    if (sessionManager.enqueueVerifyCommand) {
      await sessionManager.enqueueVerifyCommand(chatId, data.slice('run:'.length));
    } else {
      await sessionManager.runProfileCommand(chatId, data.slice('run:'.length));
    }
    return;
  }
  if (data === 'review') {
    sessionManager.review(chatId);
    return;
  }
  if (data === 'summary' || data === 'done') {
    await sessionManager.summary(chatId);
    return;
  }
  if (data === 'pr-ready') {
    await sessionManager.prReady(chatId);
    return;
  }
  if (data === 'plan:approve') {
    sessionManager.approvePlan(chatId);
    return;
  }
  if (data === 'plan:revise') {
    sessionManager.revisePlan(chatId);
    return;
  }
  if (data === 'plan:cancel') {
    sessionManager.cancelPlan(chatId);
    await send(chatId, 'Plan cancelled.');
    return;
  }
  if (data.startsWith('image-intent:')) {
    const intent = data.slice('image-intent:'.length);
    if (intent === 'attach-only') {
      await send(chatId, 'Image kept for the next prompt.');
      return;
    }
    submitPrompt(sessionManager, chatId, imageIntentPrompt(intent));
    return;
  }
  if (data === 'diff') {
    await sessionManager.diff(chatId);
    return;
  }
  if (data === 'files') {
    await sessionManager.files(chatId);
    return;
  }
  if (data === 'test') {
    if (sessionManager.enqueueTest) {
      await sessionManager.enqueueTest(chatId);
    } else {
      await sessionManager.test(chatId);
    }
    return;
  }
  if (data === 'apk') {
    await sessionManager.apk(chatId);
    return;
  }
  if (data === 'codex:last-output' || data === 'fix:last') {
    sessionManager.submitLastCommandOutputToCodex(chatId);
    return;
  }
  if (data === 'commit:confirm') {
    await sessionManager.confirmCommit(chatId);
    return;
  }
  if (data === 'commit:cancel') {
    sessionManager.cancelCommit(chatId);
    await send(chatId, 'Commit cancelled.');
    return;
  }
  if (data === 'verbose:on') {
    sessionManager.setVerbose(chatId, true);
    await send(chatId, '✅ Verbose command events enabled.');
    return;
  }
  if (data === 'verbose:off') {
    sessionManager.setVerbose(chatId, false);
    await send(chatId, '✅ Verbose command events disabled.');
    return;
  }
  if (data === 'reset') {
    sessionManager.reset(chatId);
    await send(chatId, '✅ Session reset.');
    return;
  }
  await send(chatId, 'Unknown button action. Use /help.');
}

async function requestWriteMode(chatId, config, sessionManager, send) {
  if (sessionManager.requestWriteMode) {
    const requested = sessionManager.requestWriteMode(chatId);
    if (requested === false) {
      await send(chatId, 'Write mode is disabled for this repo or server.');
      return;
    }
  }
  await send(chatId, '⚠️ Confirm write mode? Codex can modify files inside this workspace.', confirmWriteKeyboard());
}

function helpText(config) {
  const writeLine = config.allowWriteMode
    ? '/mode write - allow Codex workspace writes'
    : '/mode write - disabled by server config';
  return [
    'Codex Telegram Bridge',
    '',
    '/repos - list configured repo aliases',
    '/repo <alias-or-absolute-path> - select workspace',
    '/set-default <alias> - remember default repo for this chat',
    '/mode read - read-only sandbox',
    writeLine,
    '/work 10m|30m - enable a temporary write window',
    '/autoloop on|off - toggle automatic fix -> verify retries',
    '/diff - show git diff stat',
    '/files - show changed files',
    '/test - run configured test command',
    '/apk - build and send Flutter APK via Telegram',
    '/commit <message> - request git commit after confirmation',
    '/verbose on|off - show/hide Codex shell events',
    '/reset-task - clear current session state',
    '/continue - continue previous prompt',
    '/queue - show queued task count',
    '/cancel-queue - clear queued tasks',
    '/health - show bot configuration health',
    '/logs - show recent audit lines',
    '/cleanup - remove old attachment files',
    '/run <name> - run a repo profile command',
    '/review - ask Codex to review the current diff without edits',
    '/summary or /done - compact handoff summary',
    '/plan <task> - no-write plan with approve/revise/cancel buttons',
    '/note <text> - save repo-scoped memory in .codex-telegram/context.md',
    '/branch <name> - create a git branch after write confirmation',
    '/pr-ready - draft a PR-ready summary from local state',
    '/codex-last, /codex_last, /fix-last, or /fix_last - send the last verify output back to Codex',
    '/ask <prompt> - run Codex once',
    'normal text - same as /ask <prompt>',
    '/status - show current session',
    '/stop - stop the running task',
  ].join('\n');
}

function onboardingText(config, sessionManager, chatId) {
  const status = sessionManager.status ? sessionManager.status(chatId) : { workspace: null, mode: 'read-only' };
  if (!status.workspace && config.repoAliases && config.repoAliases.size > 0) {
    return [
      'Welcome to Codex Telegram Bridge.',
      '',
      'Step 1: choose a repo below.',
      'Step 2: send a normal message like “sửa bug login”.',
      'Write access stays locked until you explicitly enable it.',
    ].join('\n');
  }
  return `${helpText(config)}\n\nCurrent:\n${statusText(status)}`;
}

function onboardingKeyboard(config) {
  if (config.repoAliases && config.repoAliases.size > 0) {
    return repoKeyboard(config);
  }
  return mainKeyboard(config);
}

function repoListText(config) {
  if (config.repoAliases.size === 0) {
    return 'No aliases configured. Use /repo with an absolute path under WORKSPACE_ALLOWLIST.';
  }
  const lines = ['Choose a repo:'];
  for (const entry of config.repoAliases.entries()) {
    lines.push(`${entry[0]} = ${entry[1]}`);
  }
  return lines.join('\n');
}

function statusText(status) {
  return [
    `workspace: ${status.workspace || '(not selected)'}`,
    `mode: ${status.mode}`,
    `workflow: ${status.workflowState || (status.running ? 'coding' : 'idle')}`,
    `running: ${status.running ? 'yes' : 'no'}`,
    `verify: ${status.verifyRunning ? status.verifyLabel : 'idle'}`,
    `last command: ${status.lastCommandLabel || '(none)'}`,
    `pending commit: ${status.pendingCommit ? 'yes' : 'no'}`,
    `pending plan: ${status.pendingPlan ? 'yes' : 'no'}`,
    `repo notes: ${status.repoNotes && status.repoNotes.hasNotes ? 'yes' : 'no'}`,
    `autoloop: ${status.autoLoopEnabled ? 'on' : 'off'}`,
    `verbose: ${status.verbose ? 'yes' : 'no'}`,
  ].join('\n');
}

function mainKeyboard(config, sessionManager, chatId) {
  const status = sessionManager && sessionManager.status && chatId !== undefined ? sessionManager.status(chatId) : null;
  const profileButtons = profileCommandButtons(config, status && status.repoAlias);
  const writeButton = config.allowWriteMode
    ? { text: '⚠️ Write', callback_data: 'mode:write' }
    : { text: '🔒 Write disabled', callback_data: 'mode:write' };
  return {
    reply_markup: {
      inline_keyboard: [
        [{ text: 'Repos', callback_data: 'repos' }, { text: 'Status', callback_data: 'status' }, { text: 'Stop', callback_data: 'stop' }],
        [{ text: 'Read', callback_data: 'mode:read' }, writeButton],
        [{ text: 'Auto Loop On', callback_data: 'autoloop:on' }, { text: 'Auto Loop Off', callback_data: 'autoloop:off' }],
        [{ text: 'Diff', callback_data: 'diff' }, { text: 'Files', callback_data: 'files' }, { text: 'Test', callback_data: 'test' }, { text: 'APK', callback_data: 'apk' }],
        [{ text: 'Review', callback_data: 'review' }, { text: 'Summary', callback_data: 'summary' }, { text: 'PR ready', callback_data: 'pr-ready' }],
        [{ text: 'Fix last output', callback_data: 'fix:last' }],
        [{ text: 'Queue', callback_data: 'queue' }, { text: 'Cancel Queue', callback_data: 'cancel-queue' }, { text: 'Continue', callback_data: 'continue' }],
        [{ text: 'Health', callback_data: 'health' }],
        ...profileButtons,
        [{ text: 'Verbose on', callback_data: 'verbose:on' }, { text: 'Verbose off', callback_data: 'verbose:off' }],
      ],
    },
  };
}

function repoKeyboard(config) {
  const rows = [];
  for (const name of config.repoAliases.keys()) {
    rows.push([{ text: name, callback_data: `repo:${name}` }]);
  }
  return { reply_markup: { inline_keyboard: rows } };
}

function confirmWriteKeyboard() {
  return {
    reply_markup: {
      inline_keyboard: [[
        { text: 'Confirm write', callback_data: 'mode:write:confirm' },
        { text: 'Stay read-only', callback_data: 'mode:read' },
      ]],
    },
  };
}

function imageIntentKeyboard() {
  return {
    reply_markup: {
      inline_keyboard: [
        [{ text: 'Review UI', callback_data: 'image-intent:review-ui' }, { text: 'Find bug', callback_data: 'image-intent:find-bug' }],
        [{ text: 'Implement similar screen', callback_data: 'image-intent:similar-screen' }, { text: 'Attach only', callback_data: 'image-intent:attach-only' }],
      ],
    },
  };
}

function imageIntentPrompt(intent) {
  if (intent === 'review-ui') {
    return 'Review the attached UI screenshot. Identify UX issues, visual bugs, accessibility risks, and concrete implementation fixes. Do not modify files unless I approve a follow-up.';
  }
  if (intent === 'find-bug') {
    return 'Inspect the attached screenshot for likely app bugs. Explain probable root causes in the codebase and propose the smallest safe fix.';
  }
  if (intent === 'similar-screen') {
    return 'Use the attached screenshot as a reference and implement a similar screen in this app. Keep changes minimal and match existing architecture.';
  }
  return 'Keep the attached image available for the next prompt. Do not run Codex yet.';
}

function queueKeyboard() {
  return { reply_markup: { inline_keyboard: [[{ text: 'Status', callback_data: 'status' }, { text: 'Cancel Queue', callback_data: 'cancel-queue' }, { text: 'Stop', callback_data: 'stop' }]] } };
}

function profileCommandButtons(config, activeAlias) {
  const names = new Set();
  if (activeAlias && config.repoProfiles && config.repoProfiles.has(activeAlias)) {
    const activeProfile = config.repoProfiles.get(activeAlias);
    if (activeProfile.commands && typeof activeProfile.commands === 'object') {
      for (const name of Object.keys(activeProfile.commands)) {
        names.add(name);
      }
      return Array.from(names).slice(0, 3).map((name) => [{ text: name, callback_data: `run:${name}` }]);
    }
  }
  if (config.repoProfiles) {
    for (const profile of config.repoProfiles.values()) {
      if (profile.commands && typeof profile.commands === 'object') {
        for (const name of Object.keys(profile.commands)) {
          names.add(name);
        }
      }
    }
  }
  return Array.from(names).slice(0, 3).map((name) => [{ text: name, callback_data: `run:${name}` }]);
}

function submitPrompt(sessionManager, chatId, prompt) {
  if (sessionManager.submitPrompt) {
    sessionManager.submitPrompt(chatId, prompt);
    return;
  }
  sessionManager.ask(chatId, prompt);
}

async function noop() {}

function parseWorkMinutes(value) {
  const match = String(value || '').trim().match(/^(\d+)(m)?$/i);
  if (!match) {
    throw new Error('Use /work 10m or /work 30m');
  }
  return Math.max(1, Math.min(Number(match[1]), 120));
}

module.exports = { createCommandHandler, helpText, repoListText, mainKeyboard, repoKeyboard };
