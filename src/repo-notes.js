'use strict';

const fs = require('fs');
const path = require('path');

const DEFAULT_NOTES_PATH = '.codex-telegram/context.md';
const MAX_NOTE_CHARS = 500;
const MAX_CONTEXT_CHARS = 4000;

function notesPathFor(session, profile) {
  const notesPath = profile && profile.notesPath ? profile.notesPath : DEFAULT_NOTES_PATH;
  if (path.isAbsolute(notesPath)) {
    throw new Error('notesPath must be workspace-relative');
  }
  const workspaceRoot = fs.realpathSync(session.workspace);
  const resolved = path.resolve(workspaceRoot, notesPath);
  assertLexicallyInside(resolved, workspaceRoot, 'notesPath escapes workspace');
  const parent = path.dirname(resolved);
  if (fs.existsSync(parent)) {
    assertRealInside(parent, workspaceRoot, 'notesPath escapes workspace');
  }
  return resolved;
}

function appendRepoNote(session, profile, note) {
  const safeNote = sanitizeNote(note);
  if (!safeNote) {
    throw new Error('Note text is required');
  }
  const filePath = notesPathFor(session, profile);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  assertRealInside(path.dirname(filePath), fs.realpathSync(session.workspace), 'notesPath escapes workspace');
  const prefix = fs.existsSync(filePath) && fs.readFileSync(filePath, 'utf8').trim() ? '\n' : '# Codex Telegram Repo Notes\n\n';
  fs.appendFileSync(filePath, `${prefix}- ${safeNote}\n`);
  return { filePath, note: safeNote };
}

function readRepoNotes(session, profile, maxChars) {
  const filePath = notesPathFor(session, profile);
  if (!fs.existsSync(filePath)) {
    return '';
  }
  const content = fs.readFileSync(filePath, 'utf8').trim();
  if (!content) {
    return '';
  }
  const budget = Math.max(500, Number(maxChars || MAX_CONTEXT_CHARS));
  return content.length > budget ? content.slice(-budget) : content;
}

function prependRepoNotes(prompt, notes) {
  if (!notes || !String(notes).trim()) {
    return prompt;
  }
  return [
    'Repo memory notes from .codex-telegram/context.md:',
    String(notes).trim(),
    '',
    'User task:',
    prompt,
  ].join('\n');
}

function assertLexicallyInside(candidate, root, message) {
  const relative = path.relative(root, candidate);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(message);
  }
}

function assertRealInside(candidate, root, message) {
  const realCandidate = fs.realpathSync(candidate);
  const realRoot = fs.realpathSync(root);
  const relative = path.relative(realRoot, realCandidate);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(message);
  }
}

function sanitizeNote(note) {
  return String(note || '')
    .replace(/[\r\n]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_NOTE_CHARS);
}

module.exports = {
  DEFAULT_NOTES_PATH,
  appendRepoNote,
  notesPathFor,
  prependRepoNotes,
  readRepoNotes,
  sanitizeNote,
};
