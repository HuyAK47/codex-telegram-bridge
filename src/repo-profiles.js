'use strict';

function parseRepoProfiles(value) {
  const profiles = new Map();
  if (!value || !value.trim()) {
    return profiles;
  }
  const parsed = JSON.parse(value);
  for (const name of Object.keys(parsed)) {
    profiles.set(name, Object.assign({}, parsed[name]));
  }
  return profiles;
}

function getRepoProfile(config, alias) {
  return config.repoProfiles && config.repoProfiles.get(alias) ? config.repoProfiles.get(alias) : {};
}

module.exports = { getRepoProfile, parseRepoProfiles };
