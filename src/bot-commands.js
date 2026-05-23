'use strict';

function buildBotCommands() {
  return [
    { command: 'start', description: 'Start onboarding and quick buttons' },
    { command: 'repos', description: 'Choose repository' },
    { command: 'status', description: 'Show current session' },
    { command: 'health', description: 'Check bot configuration' },
    { command: 'work', description: 'Enable temporary write window' },
    { command: 'diff', description: 'Show git diff stat' },
    { command: 'files', description: 'Show changed files' },
    { command: 'test', description: 'Run configured tests' },
    { command: 'queue', description: 'Show queued tasks' },
    { command: 'logs', description: 'Show recent audit lines' },
    { command: 'stop', description: 'Stop running Codex task' },
  ];
}

module.exports = { buildBotCommands };
