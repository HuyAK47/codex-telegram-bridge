'use strict';

const fs = require('fs');
const path = require('path');
const { getRepoProfile } = require('./repo-profiles');

function parseVerifyProfiles(value) {
  const map = new Map();
  if (!value || !value.trim()) {
    return map;
  }
  const parsed = JSON.parse(value);
  for (const name of Object.keys(parsed)) {
    const entry = parsed[name] || {};
    map.set(name, {
      cwd: entry.cwd || '',
      command: entry.command || '',
      successText: entry.successText || '',
      kind: entry.kind || 'shell',
    });
  }
  return map;
}

function resolveVerifyProfile(config, session, requestedName) {
  const name = requestedName || 'default-test';
  if (config.verifyProfiles && config.verifyProfiles.has(name) && name !== 'default-test') {
    return buildResolvedProfile(name, config.verifyProfiles.get(name), session);
  }
  if (name === 'default-test') {
    if (session.repoAlias && config.verifyProfiles && config.verifyProfiles.has(session.repoAlias)) {
      return buildResolvedProfile(session.repoAlias, config.verifyProfiles.get(session.repoAlias), session);
    }
    if (config.verifyProfiles && config.verifyProfiles.has('*')) {
      return buildResolvedProfile('*', config.verifyProfiles.get('*'), session);
    }
  }

  const profile = getRepoProfile(config, session.repoAlias || '');
  const command = profile.testCommand || config.testCommands.get(session.repoAlias || '') || config.testCommands.get('*');
  if (!command || !String(command).trim()) {
    throw new Error('No test command configured for this repo');
  }
  return {
    name: session.repoAlias || name,
    label: 'Test',
    cwd: resolveProfileCwd(session.workspace, profile),
    command: command,
    successText: '',
    kind: 'shell',
  };
}

function resolveProfileCwd(workspace, profile) {
  const relativeCwd = profile && profile.cwd ? profile.cwd : '';
  if (!relativeCwd || relativeCwd === '.') {
    return workspace;
  }
  if (path.isAbsolute(relativeCwd)) {
    throw new Error('Profile cwd must be workspace-relative');
  }
  const root = fs.realpathSync(workspace);
  const cwd = path.resolve(root, relativeCwd);
  const lexicalRelative = path.relative(root, cwd);
  if (lexicalRelative.startsWith('..') || path.isAbsolute(lexicalRelative)) {
    throw new Error('Profile cwd escapes workspace');
  }
  if (!fs.existsSync(cwd)) {
    return cwd;
  }
  const realCwd = fs.realpathSync(cwd);
  const realRelative = path.relative(root, realCwd);
  if (realRelative.startsWith('..') || path.isAbsolute(realRelative)) {
    throw new Error('Profile cwd escapes workspace');
  }
  return realCwd;
}

function buildResolvedProfile(name, entry, session) {
  const cwd = resolveProfileCwd(session.workspace, entry);
  return {
    name: name,
    label: entry.label || 'Test',
    cwd: cwd,
    command: entry.command,
    successText: entry.successText || '',
    kind: entry.kind || 'shell',
  };
}

module.exports = { parseVerifyProfiles, resolveVerifyProfile };
