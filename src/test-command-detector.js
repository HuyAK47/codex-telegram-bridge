'use strict';

const fs = require('fs');
const path = require('path');

function detectTestCommand(workspace) {
  if (!workspace || !fs.existsSync(workspace)) {
    return '';
  }

  const packageCommand = detectPackageJsonCommand(workspace);
  if (packageCommand) {
    return packageCommand;
  }

  if (hasFile(workspace, 'pubspec.yaml')) {
    return isFlutterWorkspace(workspace) ? 'flutter test' : 'dart test';
  }

  if (hasFile(workspace, 'deno.json') || hasFile(workspace, 'deno.jsonc')) {
    return hasDenoTestTask(workspace) ? 'deno task test' : 'deno test';
  }

  if (hasExecutableFile(workspace, 'gradlew')) {
    return './gradlew test';
  }
  if (hasFile(workspace, 'build.gradle') || hasFile(workspace, 'build.gradle.kts') || hasFile(workspace, 'settings.gradle') || hasFile(workspace, 'settings.gradle.kts')) {
    return 'gradle test';
  }

  if (hasExecutableFile(workspace, 'mvnw')) {
    return './mvnw test';
  }
  if (hasFile(workspace, 'pom.xml')) {
    return 'mvn test';
  }

  if (hasFile(workspace, 'go.mod')) {
    return 'go test ./...';
  }

  if (hasFile(workspace, 'Cargo.toml')) {
    return 'cargo test';
  }

  if (hasPythonTestSignal(workspace)) {
    return 'python -m pytest';
  }

  if (hasMakeTestTarget(workspace)) {
    return 'make test';
  }

  return '';
}

function detectPackageJsonCommand(workspace) {
  const packageJson = readJson(path.join(workspace, 'package.json'));
  const testScript = packageJson && packageJson.scripts && packageJson.scripts.test;
  if (!testScript || !String(testScript).trim() || isNpmPlaceholderTest(testScript)) {
    return '';
  }
  const packageManager = detectPackageManager(workspace, packageJson.packageManager);
  return `${packageManager} test`;
}

function detectPackageManager(workspace, configuredPackageManager) {
  const configured = String(configuredPackageManager || '').toLowerCase();
  if (configured.startsWith('pnpm@')) {
    return 'pnpm';
  }
  if (configured.startsWith('yarn@')) {
    return 'yarn';
  }
  if (configured.startsWith('bun@')) {
    return 'bun';
  }
  if (configured.startsWith('npm@')) {
    return 'npm';
  }
  if (hasFile(workspace, 'pnpm-lock.yaml')) {
    return 'pnpm';
  }
  if (hasFile(workspace, 'yarn.lock')) {
    return 'yarn';
  }
  if (hasFile(workspace, 'bun.lock') || hasFile(workspace, 'bun.lockb')) {
    return 'bun';
  }
  return 'npm';
}

function hasDenoTestTask(workspace) {
  const denoConfig = readJson(path.join(workspace, 'deno.json')) || readJson(path.join(workspace, 'deno.jsonc'));
  return Boolean(denoConfig && denoConfig.tasks && denoConfig.tasks.test);
}

function isFlutterWorkspace(workspace) {
  const content = readText(path.join(workspace, 'pubspec.yaml'));
  return /^\s*flutter\s*:/m.test(content) || /^\s*sdk\s*:\s*flutter\s*$/m.test(content) || /^\s*flutter\s*:/m.test(sectionText(content, 'dependencies'));
}

function hasPythonTestSignal(workspace) {
  return hasFile(workspace, 'pytest.ini')
    || hasFile(workspace, 'tox.ini')
    || hasFile(workspace, 'setup.cfg')
    || hasFile(workspace, 'pyproject.toml')
    || hasDirectory(workspace, 'tests')
    || hasDirectory(workspace, 'test');
}

function hasMakeTestTarget(workspace) {
  const makefile = ['Makefile', 'makefile', 'GNUmakefile'].map((name) => path.join(workspace, name)).find((filePath) => fs.existsSync(filePath));
  if (!makefile) {
    return false;
  }
  return /^test\s*:/m.test(readText(makefile));
}

function sectionText(content, sectionName) {
  const lines = String(content || '').split(/\r?\n/);
  const start = lines.findIndex((line) => line.trim() === `${sectionName}:`);
  if (start === -1) {
    return '';
  }
  const collected = [];
  for (let index = start + 1; index < lines.length; index += 1) {
    if (/^\S/.test(lines[index])) {
      break;
    }
    collected.push(lines[index]);
  }
  return collected.join('\n');
}

function isNpmPlaceholderTest(script) {
  return /no test specified/i.test(String(script));
}

function hasFile(workspace, name) {
  try {
    return fs.statSync(path.join(workspace, name)).isFile();
  } catch (_) {
    return false;
  }
}

function hasExecutableFile(workspace, name) {
  try {
    const stats = fs.statSync(path.join(workspace, name));
    return stats.isFile() && Boolean(stats.mode & 0o111);
  } catch (_) {
    return false;
  }
}

function hasDirectory(workspace, name) {
  try {
    return fs.statSync(path.join(workspace, name)).isDirectory();
  } catch (_) {
    return false;
  }
}

function readJson(filePath) {
  try {
    return JSON.parse(readText(filePath));
  } catch (_) {
    return null;
  }
}

function readText(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch (_) {
    return '';
  }
}

module.exports = { detectTestCommand };
