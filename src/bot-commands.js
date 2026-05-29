'use strict';

function buildBotCommands() {
  return [
    { command: 'start', description: 'Start onboarding and quick buttons' },
    { command: 'repos', description: 'Choose repository' },
    { command: 'repo', description: 'Select workspace: /repo <alias>' },
    { command: 'set_default', description: 'Set default repo: /set_default <alias>' },
    { command: 'status', description: 'Show current session' },
    { command: 'health', description: 'Check bot configuration' },
    { command: 'mode', description: 'Set mode: /mode <read|write>' },
    { command: 'work', description: 'Enable temporary write window: /work <mins>' },
    { command: 'autoloop', description: 'Toggle auto fix and verify: /autoloop <on|off>' },
    { command: 'diff', description: 'Show git diff stat' },
    { command: 'files', description: 'Show changed files' },
    { command: 'test', description: 'Run configured tests' },
    { command: 'apk', description: 'Build and send Flutter APK via Telegram' },
    { command: 'commit', description: 'Request git commit: /commit <msg>' },
    { command: 'review', description: 'Review current diff without edits' },
    { command: 'summary', description: 'Summarize task state and readiness' },
    { command: 'done', description: 'Alias for /summary' },
    { command: 'plan', description: 'Plan a task before editing' },
    { command: 'note', description: 'Save repo memory: /note <text>' },
    { command: 'branch', description: 'Create branch: /branch <name>' },
    { command: 'pr_ready', description: 'Draft PR-ready handoff summary' },
    { command: 'checks', description: 'Run configured checks or explain setup' },
    { command: 'rerun_failed', description: 'Rerun failed local verify/checks' },
    { command: 'pr_create', description: 'Run configured PR creation command' },
    { command: 'codex_last', description: 'Send last verify output to Codex' },
    { command: 'fix_last', description: 'Alias for /codex_last' },
    { command: 'queue', description: 'Show queued tasks' },
    { command: 'cancel_queue', description: 'Clear queued tasks' },
    { command: 'logs', description: 'Show recent audit lines' },
    { command: 'stop', description: 'Stop running Codex task' },
    { command: 'verbose', description: 'Show/hide Codex shell commands: /verbose <on|off>' },
    { command: 'cleanup', description: 'Remove old attachments' },
    { command: 'reset_task', description: 'Clear current session state' },
    { command: 'new', description: 'Alias for /reset_task' },
    { command: 'continue', description: 'Continue previous prompt' },
    { command: 'run', description: 'Run a profile command: /run <name>' },
    { command: 'ask', description: 'Run Codex once: /ask <prompt>' }
  ];
}

module.exports = { buildBotCommands };
