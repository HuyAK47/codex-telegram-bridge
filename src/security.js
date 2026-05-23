'use strict';

const fs = require('fs');
const path = require('path');

const DEFAULT_MAX_TEXT_CHARS = 20000;
const SAFE_ENV_KEYS = new Set([
  'HOME',
  'PATH',
  'LANG',
  'LC_ALL',
  'TERM',
  'USER',
  'LOGNAME',
  'SHELL',
  'TMPDIR',
  'OPENAI_API_KEY',
  'ANTHROPIC_API_KEY',
  'GEMINI_API_KEY',
  'GOOGLE_API_KEY',
  'CODEX_HOME',
  'XDG_CONFIG_HOME',
  'XDG_CACHE_HOME',
]);

function parseAllowedUserIds(value) {
  if (!value || !value.trim()) {
    throw new Error('TELEGRAM_ALLOWED_USER_IDS is required and must be explicit');
  }

  const ids = new Set();
  for (const rawPart of value.split(',')) {
    const part = rawPart.trim();
    if (!/^\d+$/.test(part)) {
      throw new Error('TELEGRAM_ALLOWED_USER_IDS must contain numeric Telegram user IDs only');
    }
    ids.add(Number(part));
  }

  if (ids.size === 0) {
    throw new Error('TELEGRAM_ALLOWED_USER_IDS must not be empty');
  }

  return ids;
}

function parseAllowlistRoots(value) {
  if (!value || !value.trim()) {
    throw new Error('WORKSPACE_ALLOWLIST is required');
  }

  return value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => fs.realpathSync(path.resolve(item)));
}

function isInsideOrEqual(candidate, root) {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function resolveAllowedWorkspace(requestedPath, allowlistRoots) {
  if (!requestedPath || !requestedPath.trim()) {
    throw new Error('Workspace path is required');
  }

  const resolved = fs.realpathSync(path.resolve(requestedPath.trim()));
  const allowed = allowlistRoots.some((root) => isInsideOrEqual(resolved, fs.realpathSync(root)));

  if (!allowed) {
    throw new Error(`Workspace is not allowlisted: ${resolved}`);
  }

  return resolved;
}

function validateTelegramText(text, maxChars) {
  if (typeof text !== 'string') {
    throw new Error('Message text is required');
  }

  const limit = maxChars || DEFAULT_MAX_TEXT_CHARS;
  if (text.length > limit) {
    throw new Error(`Message is too long; max ${limit} characters`);
  }

  if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(text)) {
    throw new Error('Message contains blocked control characters');
  }

  return text.trim();
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function redactSensitiveText(text, env) {
  let output = String(text || '');
  const source = env || process.env;

  for (const key of Object.keys(source)) {
    const value = source[key];
    if (!value || String(value).length < 4) {
      continue;
    }
    if (!/(token|secret|password|api[_-]?key|private[_-]?key)/i.test(key)) {
      continue;
    }
    output = output.replace(new RegExp(escapeRegExp(String(value)), 'g'), `[REDACTED:${key}]`);
  }

  output = output.replace(/\b(Bearer\s+)[A-Za-z0-9._~+/-]{12,}/gi, '$1[REDACTED:TOKEN]');
  output = output.replace(/\b(token|secret|password|api[_-]?key)\s*[=:]\s*[^\s]+/gi, '$1=[REDACTED]');
  return output;
}

function buildSafeEnv(env) {
  const input = env || process.env;
  const output = {};

  for (const key of SAFE_ENV_KEYS) {
    if (input[key]) {
      output[key] = input[key];
    }
  }

  output.CI = '1';
  output.NO_COLOR = '1';
  return output;
}

function chunkTelegramMessage(text, limit) {
  const max = Math.max(100, Math.min(limit || 3800, 4096));
  const value = String(text || '');
  if (!value) {
    return [''];
  }

  const chunks = [];
  for (let index = 0; index < value.length; index += max) {
    chunks.push(value.slice(index, index + max));
  }
  return chunks;
}

function assertAllowedUser(userId, allowedUserIds) {
  if (!allowedUserIds.has(Number(userId))) {
    throw new Error('Telegram user is not allowlisted');
  }
}

module.exports = {
  buildSafeEnv,
  chunkTelegramMessage,
  parseAllowedUserIds,
  parseAllowlistRoots,
  redactSensitiveText,
  resolveAllowedWorkspace,
  validateTelegramText,
  assertAllowedUser,
};
