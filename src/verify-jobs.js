'use strict';

function createVerifyJob(fields) {
  const source = fields || {};
  return {
    id: source.id || '',
    chatId: source.chatId == null ? null : source.chatId,
    label: source.label || 'Verify',
    repoAlias: source.repoAlias || '',
    workspace: source.workspace || '',
    cwd: source.cwd || source.workspace || '',
    command: source.command || '',
    status: source.status || 'queued',
    attempts: Number(source.attempts || 0),
    startedAt: Number(source.startedAt || 0),
    finishedAt: Number(source.finishedAt || 0),
    lastExitCode: source.lastExitCode == null ? null : source.lastExitCode,
    lastOutput: source.lastOutput || '',
    successText: source.successText || '',
    sourcePrompt: source.sourcePrompt || '',
  };
}

module.exports = { createVerifyJob };
