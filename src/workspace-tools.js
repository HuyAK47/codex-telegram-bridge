'use strict';

const { spawn } = require('child_process');
const { redactSensitiveText } = require('./security');

function buildDiffCommand(workspace) {
  return { command: 'git', args: ['-C', workspace, 'diff', '--stat'] };
}

function buildFilesCommand(workspace) {
  return { command: 'git', args: ['-C', workspace, 'status', '--short'] };
}

function buildTestCommand(workspace, testCommand) {
  if (!testCommand || !testCommand.trim()) {
    throw new Error('No test command configured for this repo');
  }
  return { command: '/bin/bash', args: ['-lc', testCommand], cwd: workspace };
}

function buildBranchCommand(workspace, branchName) {
  const safeName = String(branchName || '').trim();
  if (!safeName) {
    throw new Error('Branch name is required');
  }
  if (safeName.startsWith('-') || safeName.includes('..') || /[\s~^:?*[\]\\]/.test(safeName)) {
    throw new Error('Invalid branch name');
  }
  if (!/^[A-Za-z0-9._\/-]+$/.test(safeName) || safeName.endsWith('/') || safeName.endsWith('.')) {
    throw new Error('Invalid branch name');
  }
  return { command: 'git', args: ['-C', workspace, 'checkout', '-b', safeName] };
}

function buildPrReadyCommand(workspace) {
  return {
    command: '/bin/bash',
    args: ['-lc', "printf '%s\n' '--- diff stat ---'; git diff --stat; printf '%s\n' ''; printf '%s\n' '--- changed files ---'; git status --short; printf '%s\n' ''; printf '%s\n' '--- recent commits ---'; git log --oneline -5"],
    cwd: workspace,
  };
}

function buildCommitCommand(workspace, message) {
  if (!message || !message.trim()) {
    throw new Error('Commit message is required');
  }
  if (/[\r\n]/.test(message)) {
    throw new Error('Commit message must be a single line');
  }
  return { command: 'git', args: ['-C', workspace, 'commit', '-m', message.trim()] };
}

function runWorkspaceCommand(spec, timeoutMs) {
  return new Promise((resolve) => {
    const child = spawn(spec.command, spec.args, {
      cwd: spec.cwd,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
    }, timeoutMs || 120000);

    child.stdout.on('data', (chunk) => {
      output += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk) => {
      output += chunk.toString('utf8');
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      resolve({ code: 1, output: redactSensitiveText(error.message, process.env) });
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      const suffix = signal ? `\n(signal ${signal})` : '';
      resolve({ code, output: redactSensitiveText((output || '(no output)').trim() + suffix, process.env) });
    });
  });
}

module.exports = {
  buildBranchCommand,
  buildCommitCommand,
  buildDiffCommand,
  buildFilesCommand,
  buildPrReadyCommand,
  buildTestCommand,
  runWorkspaceCommand,
};
