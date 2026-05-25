'use strict';

function buildSmartErrorResponse(message) {
  const text = String(message || 'Unknown error');
  if (/No workspace selected|Use \/repos|Use \/repo/i.test(text)) {
    return response(
      `No repo selected yet. Choose a repo, then send your request again.\n\n${text}`,
      [[{ text: 'Choose Repo', callback_data: 'repos' }, { text: 'Status', callback_data: 'status' }]]
    );
  }
  if (/trusted directory|skip-git-repo-check|not inside a trusted/i.test(text)) {
    return response(
      `Current folder is not a trusted Codex repo. Choose another repo or enable CODEX_SKIP_GIT_REPO_CHECK in .env and restart.\n\n${text}`,
      [[{ text: 'Choose Repo', callback_data: 'repos' }, { text: 'Status', callback_data: 'status' }]]
    );
  }
  if (/read-only|write mode|requires confirmed write|permission denied|workspace-write/i.test(text)) {
    return response(
      `This action needs write access. Enable a temporary write window, then retry.\n\n${text}`,
      [[{ text: 'Enable Write', callback_data: 'mode:write' }, { text: 'Stay Read-only', callback_data: 'mode:read' }]]
    );
  }
  if (/No test command configured|No test command configured or detected/i.test(text)) {
    return response(
      `I could not auto-detect a test command for this repo. Set TEST_COMMANDS or REPO_PROFILES_JSON in .env and restart.\n\n${text}`,
      [[{ text: 'Status', callback_data: 'status' }]]
    );
  }
  return response(`❌ ${text}`, [[{ text: 'Status', callback_data: 'status' }]]);
}

function response(text, inlineKeyboard) {
  return { text, options: { reply_markup: { inline_keyboard: inlineKeyboard } } };
}

module.exports = { buildSmartErrorResponse };
