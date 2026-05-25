#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"

usage() {
  cat <<'USAGE'
Usage: ./run.sh [start|doctor|setup-telegram|test|check]

Commands:
  start           Load .env, run doctor, then start the Telegram bridge (default)
  doctor          Load .env and validate configuration
  setup-telegram  Load .env and register Telegram bot commands
  test            Run the local regression test suite
  check           Run syntax checks and the local regression test suite

Set SKIP_DOCTOR=1 ./run.sh start to skip the preflight doctor check.
USAGE
}

load_env() {
  if [ ! -f .env ]; then
    echo "❌ Missing .env. Copy .env.example first:" >&2
    echo "   cp .env.example .env" >&2
    exit 1
  fi

  set -a
  # shellcheck disable=SC1091
  . ./.env
  set +a
}

run_doctor() {
  load_env
  npm run doctor
}

run_start() {
  load_env
  if [ "${SKIP_DOCTOR:-0}" != "1" ]; then
    npm run doctor
  fi
  exec npm start
}

run_check() {
  node -c src/telegram.js
  node -c src/session-manager.js
  node -c src/commands.js
  node -c src/bot-commands.js
  npm test
}

case "${1:-start}" in
  start)
    run_start
    ;;
  doctor)
    run_doctor
    ;;
  setup-telegram|setup)
    load_env
    npm run setup-telegram
    ;;
  test)
    npm test
    ;;
  check)
    run_check
    ;;
  -h|--help|help)
    usage
    ;;
  *)
    echo "❌ Unknown command: $1" >&2
    usage >&2
    exit 1
    ;;
esac
