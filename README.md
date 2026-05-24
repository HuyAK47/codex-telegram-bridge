# Codex Telegram Bridge

Security-first Telegram bot that lets you talk to `codex exec` without opening VS Code or a shell.

This bot turns Telegram into a mobile coding assistant for your local/remote repos: choose a repo, chat naturally, let Codex inspect or edit files, run tests, review diffs, and keep write access guarded by explicit approvals, repo allowlists, and auto-expiring write windows.

## Security Model

- The bot rejects every Telegram user except IDs in `TELEGRAM_ALLOWED_USER_IDS`.
- Workspaces must be inside `WORKSPACE_ALLOWLIST`; symlink escapes are rejected with `realpath` checks.
- Default mode is `read-only`; write mode requires `ALLOW_WRITE_MODE=true` and `/mode write`.
- Write mode also requires confirmation and auto-expires after `WRITE_MODE_TTL_MS`.
- `WRITE_REPO_ALIASES` can restrict which repo aliases may ever enter write mode.
- Last selected repo can be persisted with `SESSION_STATE_PATH`, but write mode is never restored after restart.
- Codex runs with `--sandbox read-only` or `--sandbox workspace-write`, never danger-full-access.
- Codex git/trusted-directory checks stay enabled unless `CODEX_SKIP_GIT_REPO_CHECK=true` is set.
- Telegram bot tokens and secret-looking values are redacted from outbound messages/logs.
- Messages are capped, control characters are blocked, and attachments are ignored in this MVP.
- Environment passed to Codex is minimal and does not include the Telegram bot token.
- Codex command events are hidden by default; set `CODEX_SHOW_COMMAND_EVENTS=true` for debugging.

## Setup

```bash
cd codex-telegram-bridge
cp .env.example .env
```

### 1. Create A Telegram Bot

1. Open Telegram and chat with `@BotFather`.
2. Send `/newbot` and follow the prompts.
3. Copy the token BotFather returns, for example `123456:ABC...`.
4. Put that token in `.env` as `TELEGRAM_BOT_TOKEN`.
5. Send a message to your new bot once so Telegram creates the chat.

### 2. Find Your Telegram User ID

Use one of these methods:

- Chat with `@userinfobot` and copy your numeric ID.
- Or temporarily run the bot, send `/start`, and inspect logs if you add logging around blocked users.

Put the numeric ID in `.env`:

```env
TELEGRAM_ALLOWED_USER_IDS=123456789
```

For extra hardening, restrict allowed chat IDs too:

```env
TELEGRAM_ALLOWED_CHAT_IDS=123456789
```

Leave `TELEGRAM_ALLOWED_CHAT_IDS=` empty if you only want to restrict by user ID.

### 3. Configure `.env`

The `.env.example` file already contains Vietnamese comments and concrete example values for `chess-app`. Copy it to `.env`, then change these fields first:

- `TELEGRAM_BOT_TOKEN`: token from `@BotFather`.
- `TELEGRAM_ALLOWED_USER_IDS`: your Telegram numeric user ID.
- `WORKSPACE_ALLOWLIST`: parent folder containing repos the bot may access.
- `REPO_ALIASES`: short names for repos, for example `chess=/home/dev/projects/chess-app`.
- `DEFAULT_WORKSPACE`: repo used before you select another repo.
- `WRITE_REPO_ALIASES`: repo aliases allowed to enter write mode.

Minimal example:

```env
TELEGRAM_BOT_TOKEN=123456:replace-me
TELEGRAM_ALLOWED_USER_IDS=123456789
TELEGRAM_ALLOWED_CHAT_IDS=
WORKSPACE_ALLOWLIST=/home/dev/projects
DEFAULT_WORKSPACE=/home/dev/projects/chess-app
REPO_ALIASES=chess=/home/dev/projects/chess-app
DEFAULT_CODEX_MODE=read
ALLOW_WRITE_MODE=true
WRITE_REPO_ALIASES=chess
WRITE_MODE_TTL_MS=1800000
```

Important `.env` notes:

- Values containing spaces must be quoted, for example `TEST_COMMANDS='chess=flutter test,*=npm test'`.
- `REPO_PROFILES_JSON` must stay on one line and should be quoted.
- Do not set `WORKSPACE_ALLOWLIST=/`; keep it scoped to your projects folder.
- Keep `DEFAULT_CODEX_MODE=read`; use `/mode write` or `/work 30m` from Telegram when write access is needed.

### 4. Run The Bot

Export `.env`, then start:

```bash
set -a
. ./.env
set +a
npm run doctor
npm start
```

After the bot starts, open Telegram and send:

```text
/start
/repo chess
/status
```

Optional: configure Telegram's blue command menu:

```bash
npm run setup-telegram
```

## Commands

- `/help` shows available commands.
- `/repos` lists configured aliases from `REPO_ALIASES`.
- `/repo <alias-or-absolute-path>` selects the workspace.
- `/set-default <alias>` remembers the default repo for this chat.
- `/mode read` uses Codex read-only sandbox.
- `/mode write` uses Codex workspace-write sandbox when enabled server-side.
- `/work 10m|30m` enables a temporary write window for the current repo.
- `/diff` shows `git diff --stat`.
- `/files` shows changed files with `git status --short`.
- `/test` runs the configured command from `TEST_COMMANDS`.
- Repo profiles can override test/default prompts with `REPO_PROFILES_JSON`.
- `/commit <message>` requests a git commit after write-mode confirmation.
- `/verbose on|off` shows or hides Codex shell command events.
- `/reset-task` clears the current chat session state.
- `/continue` continues the previous prompt.
- `/queue` shows queued task count.
- `/cancel-queue` clears queued tasks.
- `/health` shows bot/repo/Codex configuration health.
- `/logs` shows recent redacted audit lines.
- `/cleanup` removes old Telegram attachment files.
- `/run <name>` runs a repo profile command such as `Analyze` or `Flutter Test`.
- `/ask <prompt>` starts one non-interactive Codex run.
- Any normal chat message also starts a Codex run, so `/ask` is optional after setup.
- `/status` shows workspace, mode, and running state.
- `/stop` sends `SIGTERM` to the running Codex process.

## Recommended First Run

Keep `ALLOW_WRITE_MODE=false` and test with:

```text
/repo my-project
/mode read
/ask inspect this repo and summarize the architecture; do not modify files
```

Only enable writes after the read-only flow works:

```bash
ALLOW_WRITE_MODE=true
DEFAULT_CODEX_MODE=read
```

Then explicitly switch a chat session with `/mode write`.

## UX Helpers

- `/start`, `/status`, and `/repos` include Telegram inline buttons.
- `/start` now acts as a mobile onboarding wizard when no repo is selected.
- Normal chat text is treated as a Codex prompt after a workspace is selected.
- `/set-default <alias>` lets future bot restarts use your active project without choosing it again.
- If Codex reports a read-only/write denial, the bot offers `Enable write & retry`.
- Common errors include action buttons such as `Choose Repo`, `Status`, or `Enable Write`.
- Write-like prompts such as “sửa bug” or “implement” automatically ask for write confirmation.
- Prompts sent while Codex is busy are queued and run after the current task.
- Long-running tasks send heartbeat messages controlled by `HEARTBEAT_MS`.
- Set `CODEX_RESUME_LAST=true` to try `codex exec resume --last` for a more persistent conversation.
- Set `DASHBOARD_PORT` to expose a tiny local dashboard with `/health` and `/sessions`.
- Send a Telegram image, then send a prompt; the image is passed to Codex with `--image` when `ATTACHMENT_DIR` is configured.
- After a successful task, the bot shows action buttons for `Continue`, `Work 30m`, `Diff`, `Files`, `Test`, and `Status`.
- `TEST_COMMANDS` maps repo aliases to commands, for example `chess=flutter test,*=npm test`.
- `AUDIT_LOG_PATH` enables JSONL logs for repo selection, mode changes, prompts, and command events.
- `SESSION_STATE_PATH` remembers the last repo/verbose setting per chat, always restoring read-only mode.
- `CODEX_SHOW_COMMAND_EVENTS=false` keeps Telegram chat clean; use `/verbose on` per session when debugging.

## Advanced Options

- `HEARTBEAT_MS=60000` sends periodic `Still running...` messages during long tasks. Use `0` to disable.
- `CODEX_RESUME_LAST=true` switches Codex calls to `codex exec resume --last --json`.
- The bot stores Codex `thread_id` per chat when available and resumes that exact thread for follow-up prompts. This makes short replies like “làm 1,2,3” more reliable than starting a fresh Codex run.
- `REPO_PROFILES_JSON` supports per-repo defaults, for example `{"chess":{"testCommand":"flutter test","defaultPrompt":"You are working on a Flutter chess app."}}`.
- `DASHBOARD_HOST=127.0.0.1` and `DASHBOARD_PORT=8787` enable a local JSON dashboard at `/health` and `/sessions`.
- `ATTACHMENT_DIR=/tmp/codex-telegram-bridge-attachments` stores Telegram images before passing them to Codex.
- `ATTACHMENT_MAX_AGE_MS=86400000` controls how old files must be before `/cleanup` deletes them.
- `TELEGRAM_ALLOWED_CHAT_IDS` optionally restricts usage to specific chat IDs in addition to user IDs.

## Operations

- Run `npm run doctor` to validate `.env` and print a health report before starting the bot.
- Run `npm run setup-telegram` to configure Telegram's blue command menu automatically.
- Use `deploy/codex-telegram-bridge.service` as a starting point for a systemd service.
- Use `/health`, `/logs`, and `/cleanup` from Telegram for day-to-day operation checks.

## Context And Follow-Ups

- Keep `CODEX_RESUME_LAST=true` for normal use. The bridge first tries to resume the stored Codex `thread_id` for the current Telegram chat.
- Use `/continue` or the `Continue` button after a task when you want Codex to continue the previous work without restating everything.
- If a follow-up is ambiguous, include the subject explicitly, for example `làm bước 1,2,3 trong danh sách Sprint 2 ở câu trả lời trước` instead of only `làm 1,2,3`.
- If context feels wrong, use `/status` to confirm the current repo, then `/reset-task` to clear the chat session state and start fresh.
- If you switch repos with `/repo <alias>`, the bridge resets the mode to read-only and future prompts use the newly selected repo.

## Common Codex Errors

- `401 Unauthorized` or `token_invalidated`: refresh Codex authentication on the machine running the bot with `codex login`, then restart the bot.
- `429 Too Many Requests`: wait for the rate limit to cool down, reduce queued prompts, or switch to a less busy model/profile if configured.
- `Not inside a trusted directory`: choose a real git repo with `/repo <alias>`, or set `CODEX_SKIP_GIT_REPO_CHECK=true` only for intentional non-git scratch folders.
- Read-only/write denial: use `/mode write`, `/work 30m`, or the `Enable write & retry` button. Write mode still requires `ALLOW_WRITE_MODE=true` and a matching `WRITE_REPO_ALIASES` entry.
- `bwrap` or permission denied errors on Ubuntu 24.04+: see the [Ubuntu bwrap fix guide](docs/ubuntu-bwrap-fix.md) for details on sysctl and AppArmor configuration.


## Notes

This MVP uses Telegram long polling and `codex exec --json` for one task at a time per chat. It does not expose a public HTTP server.

If Codex replies `Not inside a trusted directory and --skip-git-repo-check was not specified`, prefer selecting a real git repo with `/repo <alias>`. For non-git scratch folders only, set `CODEX_SKIP_GIT_REPO_CHECK=true` and restart the bot.
