'use strict';

function buildHealthReport(config) {
  const aliases = [];
  if (config.repoAliases) {
    for (const entry of config.repoAliases.entries()) {
      aliases.push(`${entry[0]}=${entry[1]}`);
    }
  }
  return [
    'Health report',
    `codex: ${config.codexBin || 'codex'}`,
    `default workspace: ${config.defaultWorkspace || '(none)'}`,
    `repos: ${aliases.join(', ') || '(none)'}`,
    `write enabled: ${config.allowWriteMode ? 'yes' : 'no'}`,
    `write repos: ${config.writeRepoAliases && config.writeRepoAliases.size ? Array.from(config.writeRepoAliases).join(', ') : '(all allowed repos)'}`,
    `dashboard: ${config.dashboardPort ? `${config.dashboardHost || '127.0.0.1'}:${config.dashboardPort}` : 'off'}`,
  ].join('\n');
}

module.exports = { buildHealthReport };
