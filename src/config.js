'use strict';

const fs = require('fs');
const path = require('path');
const {
  parseAllowedUserIds,
  parseAllowlistRoots,
  resolveAllowedWorkspace,
} = require('./security');
const { parseRepoProfiles } = require('./repo-profiles');
const { parseVerifyProfiles } = require('./verify-profiles');

function parseRepoAliases(value, allowlistRoots) {
  const aliases = new Map();
  if (!value || !value.trim()) {
    return aliases;
  }

  for (const rawEntry of value.split(',')) {
    const entry = rawEntry.trim();
    if (!entry) {
      continue;
    }
    const separator = entry.indexOf('=');
    if (separator <= 0) {
      throw new Error('REPO_ALIASES entries must look like name=/absolute/path');
    }
    const name = entry.slice(0, separator).trim();
    const repoPath = entry.slice(separator + 1).trim();
    if (!/^[a-zA-Z0-9._-]+$/.test(name)) {
      throw new Error(`Invalid repo alias: ${name}`);
    }
    aliases.set(name, resolveAllowedWorkspace(repoPath, allowlistRoots));
  }

  return aliases;
}

function loadConfig(env) {
  const source = env || process.env;
  const allowlistRoots = parseAllowlistRoots(source.WORKSPACE_ALLOWLIST);
  const repoAliases = parseRepoAliases(source.REPO_ALIASES, allowlistRoots);
  const defaultWorkspace = source.DEFAULT_WORKSPACE
    ? resolveAllowedWorkspace(source.DEFAULT_WORKSPACE, allowlistRoots)
    : null;
  const allowWriteMode = source.ALLOW_WRITE_MODE === 'true';
  const sandboxMode = source.DEFAULT_CODEX_MODE === 'write' ? 'workspace-write' : 'read-only';

  if (source.DEFAULT_CODEX_MODE && !/^(read|write)$/.test(source.DEFAULT_CODEX_MODE)) {
    throw new Error('DEFAULT_CODEX_MODE must be read or write');
  }
  if (sandboxMode === 'workspace-write' && !allowWriteMode) {
    throw new Error('DEFAULT_CODEX_MODE=write requires ALLOW_WRITE_MODE=true');
  }

  return {
    telegramBotToken: required(source.TELEGRAM_BOT_TOKEN, 'TELEGRAM_BOT_TOKEN'),
    allowedUserIds: parseAllowedUserIds(source.TELEGRAM_ALLOWED_USER_IDS),
    allowedChatIds: parseOptionalNumberSet(source.TELEGRAM_ALLOWED_CHAT_IDS),
    allowlistRoots,
    repoAliases,
    defaultWorkspace,
    codexBin: source.CODEX_BIN || 'codex',
    sandboxMode,
    allowWriteMode,
    pollIntervalMs: Number(source.POLL_INTERVAL_MS || 1000),
    maxPromptChars: Number(source.MAX_PROMPT_CHARS || 20000),
    telegramMessageLimit: Number(source.TELEGRAM_MESSAGE_LIMIT || 3800),
    codexExtraArgs: parseExtraArgs(source.CODEX_EXTRA_ARGS),
    codexSkipGitRepoCheck: source.CODEX_SKIP_GIT_REPO_CHECK === 'true',
    codexShowCommandEvents: source.CODEX_SHOW_COMMAND_EVENTS === 'true',
    writeModeTtlMs: Number(source.WRITE_MODE_TTL_MS || 1800000),
    testCommands: parseKeyValueMap(source.TEST_COMMANDS),
    writeRepoAliases: parseNameSet(source.WRITE_REPO_ALIASES),
    auditLogPath: source.AUDIT_LOG_PATH || '',
    workspaceCommandTimeoutMs: Number(source.WORKSPACE_COMMAND_TIMEOUT_MS || 120000),
    sessionStatePath: source.SESSION_STATE_PATH || '',
    heartbeatMs: Number(source.HEARTBEAT_MS || 60000),
    codexResumeLast: source.CODEX_RESUME_LAST === 'true',
    repoProfiles: parseRepoProfiles(source.REPO_PROFILES_JSON),
    verifyProfiles: parseVerifyProfiles(source.VERIFY_PROFILES_JSON),
    verifyRunnerMode: source.VERIFY_RUNNER_MODE || 'local-shell',
    maxAutoLoopAttempts: Number(source.MAX_AUTO_LOOP_ATTEMPTS || 3),
    autoLoopDefault: source.AUTO_LOOP_DEFAULT === 'true',
    dashboardHost: source.DASHBOARD_HOST || '127.0.0.1',
    dashboardPort: Number(source.DASHBOARD_PORT || 0),
    attachmentDir: source.ATTACHMENT_DIR || '',
    attachmentMaxAgeMs: Number(source.ATTACHMENT_MAX_AGE_MS || 86400000),
  };
}

function required(value, name) {
  if (!value || !value.trim()) {
    throw new Error(`${name} is required`);
  }
  return value.trim();
}

function parseExtraArgs(value) {
  if (!value || !value.trim()) {
    return [];
  }
  const filePath = path.resolve(value.trim());
  const content = fs.readFileSync(filePath, 'utf8');
  const parsed = JSON.parse(content);
  if (!Array.isArray(parsed) || !parsed.every((item) => typeof item === 'string')) {
    throw new Error('CODEX_EXTRA_ARGS must point to a JSON string array');
  }
  return parsed;
}

function parseKeyValueMap(value) {
  const map = new Map();
  if (!value || !value.trim()) {
    return map;
  }
  for (const rawEntry of value.split(',')) {
    const entry = rawEntry.trim();
    if (!entry) {
      continue;
    }
    const separator = entry.indexOf('=');
    if (separator <= 0) {
      throw new Error('Map entries must look like name=value');
    }
    const name = entry.slice(0, separator).trim();
    if (name !== '*' && !/^[a-zA-Z0-9._-]+$/.test(name)) {
      throw new Error(`Invalid map key: ${name}`);
    }
    map.set(name, entry.slice(separator + 1).trim());
  }
  return map;
}

function parseNameSet(value) {
  if (!value || !value.trim()) {
    return new Set();
  }
  return new Set(value.split(',').map((item) => item.trim()).filter(Boolean));
}

function parseOptionalNumberSet(value) {
  if (!value || !value.trim()) {
    return new Set();
  }
  const ids = new Set();
  for (const rawPart of value.split(',')) {
    const part = rawPart.trim();
    if (!/^[-]?\d+$/.test(part)) {
      throw new Error('TELEGRAM_ALLOWED_CHAT_IDS must contain numeric chat IDs only');
    }
    ids.add(Number(part));
  }
  return ids;
}

module.exports = { loadConfig, parseRepoAliases, parseKeyValueMap, parseNameSet, parseOptionalNumberSet };
