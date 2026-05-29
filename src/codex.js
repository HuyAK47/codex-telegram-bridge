'use strict';

const { spawn } = require('child_process');
const { buildSafeEnv, redactSensitiveText } = require('./security');

function runCodexOnce(options) {
  const args = buildCodexArgs(options);
  return spawn(options.codexBin, args, {
    cwd: options.workspace,
    env: buildSafeEnv(process.env),
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

function buildCodexArgs(options) {
  const settings = options || {};
  const args = settings.resumeSessionId
    ? ['exec', 'resume', '--json', settings.resumeSessionId]
    : ['exec', '--json', '--color', 'never', '--sandbox', settings.sandboxMode, '--cd', settings.workspace];

  if (settings.skipGitRepoCheck) {
    args.push('--skip-git-repo-check');
  }

  for (const extraArg of settings.extraArgs || []) {
    args.push(extraArg);
  }

  for (const imagePath of settings.imagePaths || []) {
    args.push('--image', imagePath);
  }

  args.push('-');
  return args;
}

function formatCodexJsonLine(line, options) {
  const settings = options || {};
  const trimmed = line.trim();
  if (!trimmed) {
    return '';
  }

  try {
    const event = JSON.parse(trimmed);
    if (event.type === 'thread.started' || event.type === 'turn.started' || event.type === 'turn.completed') {
      return '';
    }
    if ((event.type === 'item.started' || event.type === 'item.updated') && (!event.item || event.item.type !== 'command_execution')) {
      return '';
    }
    if (event.type === 'item.started' && event.item && event.item.type === 'command_execution') {
      if (!settings.showCommandEvents) {
        return '';
      }
      return `⚙️ Running: ${event.item.command}`;
    }
    if (event.type === 'item.completed' && event.item) {
      if (event.item.type === 'agent_message') {
        return event.item.text || '';
      }
      if (event.item.type === 'command_execution') {
        if (!settings.showCommandEvents) {
          return '';
        }
        const status = event.item.status || 'completed';
        const exitCode = event.item.exit_code === null || event.item.exit_code === undefined
          ? ''
          : ` exit ${event.item.exit_code}`;
        const output = event.item.aggregated_output ? `\n${event.item.aggregated_output.trim()}` : '';
        return `✅ Command ${status}${exitCode}: ${event.item.command}${output}`;
      }
      return '';
    }
    if (event.msg && typeof event.msg === 'string') {
      return event.msg;
    }
    if (event.message && typeof event.message === 'string') {
      return event.message;
    }
    if (event.delta && typeof event.delta === 'string') {
      return event.delta;
    }
    if (event.type) {
      return `[${event.type}] ${event.summary || event.text || ''}`.trim();
    }
    return trimmed;
  } catch (_error) {
    return trimmed;
  }
}

function extractCodexEventInfo(line) {
  const trimmed = String(line || '').trim();
  if (!trimmed) {
    return {};
  }
  try {
    const event = JSON.parse(trimmed);
    if (event.type === 'thread.started' && event.thread_id) {
      return { threadId: event.thread_id };
    }
    if (event.type === 'item.completed' && event.item && event.item.type === 'agent_message') {
      return { assistantText: event.item.text || '' };
    }
  } catch (_error) {
    return {};
  }
  return {};
}

function redactOutput(text) {
  return redactSensitiveText(text, process.env);
}

module.exports = { buildCodexArgs, extractCodexEventInfo, formatCodexJsonLine, redactOutput, runCodexOnce };
