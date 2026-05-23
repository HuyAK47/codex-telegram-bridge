# Telegram Bot UX Security Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Telegram Codex bridge easier to use while preserving explicit write permissions and auditability.

**Architecture:** Keep Telegram command routing in `src/commands.js`, process execution in focused helper modules, and security policy in config/session state. Inline buttons use Telegram `callback_query` events and map to the same command handler paths as typed commands.

**Tech Stack:** Node.js 12 CommonJS, Telegram Bot HTTP API, Codex CLI, built-in `child_process`, no external dependencies.

---

### Task 1: Chat UX and Buttons

**Files:**
- Modify: `src/commands.js`
- Modify: `src/index.js`
- Test: `test/run.js`

- [ ] Add tests that `/start`, `/status`, and `/repos` return inline keyboards.
- [ ] Implement callback query routing for repo selection, mode changes, status, stop, diff, files, test, verbose, reset.
- [ ] Keep normal text as Codex prompts and unknown slash commands as errors.

### Task 2: Safe Git Helpers

**Files:**
- Create: `src/workspace-tools.js`
- Test: `test/run.js`

- [ ] Add tests for `/diff`, `/files`, `/test`, and `/commit` command construction.
- [ ] Implement read-only git diff/stat helpers and configured test command execution.
- [ ] Require explicit commit approval before `git commit` runs.

### Task 3: Permission and Audit

**Files:**
- Modify: `src/config.js`
- Modify: `src/session-manager.js`
- Create: `src/audit.js`
- Test: `test/run.js`

- [ ] Add repo-level write policy parsing.
- [ ] Add write mode confirmation and auto-timeout.
- [ ] Add audit logging for prompts, repo changes, mode changes, task start/end, and commands.

### Task 4: Documentation and Verification

**Files:**
- Modify: `.env.example`
- Modify: `README.md`

- [ ] Document new env vars and commands.
- [ ] Run `npm test` and syntax checks for changed files.
