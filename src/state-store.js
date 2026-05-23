'use strict';

const fs = require('fs');
const path = require('path');

class StateStore {
  constructor(filePath) {
    this.filePath = filePath || '';
  }

  loadSession(chatId) {
    const state = this.readState();
    const session = state.sessions[String(chatId)];
    const defaults = state.defaults[String(chatId)];
    if (!session && !defaults) {
      return null;
    }
    if (!session && defaults) {
      return {
        workspace: defaults.workspace || null,
        repoAlias: defaults.repoAlias || '',
        mode: 'read-only',
        verbose: false,
        codexThreadId: defaults.codexThreadId || '',
      };
    }
    return {
      workspace: session.workspace || null,
      repoAlias: session.repoAlias || '',
      mode: 'read-only',
      verbose: Boolean(session.verbose),
      codexThreadId: session.codexThreadId || '',
    };
  }

  saveSession(chatId, session) {
    if (!this.filePath) {
      return;
    }
    const state = this.readState();
    state.sessions[String(chatId)] = {
      workspace: session.workspace || null,
      repoAlias: session.repoAlias || '',
      mode: 'read-only',
      verbose: Boolean(session.verbose),
      codexThreadId: session.codexThreadId || '',
      updatedAt: new Date().toISOString(),
    };
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    fs.writeFileSync(this.filePath, JSON.stringify(state, null, 2));
  }

  saveDefault(chatId, session) {
    if (!this.filePath) {
      return;
    }
    const state = this.readState();
    state.defaults[String(chatId)] = {
      workspace: session.workspace || null,
      repoAlias: session.repoAlias || '',
      codexThreadId: session.codexThreadId || '',
      updatedAt: new Date().toISOString(),
    };
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    fs.writeFileSync(this.filePath, JSON.stringify(state, null, 2));
  }

  readState() {
    if (!this.filePath || !fs.existsSync(this.filePath)) {
      return { sessions: {}, defaults: {} };
    }
    try {
      const parsed = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
      if (!parsed.sessions || typeof parsed.sessions !== 'object') {
        parsed.sessions = {};
      }
      if (!parsed.defaults || typeof parsed.defaults !== 'object') {
        parsed.defaults = {};
      }
      return parsed;
    } catch (_error) {
      return { sessions: {}, defaults: {} };
    }
  }
}

module.exports = { StateStore };
