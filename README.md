# Codex Telegram Bridge

Codex Telegram Bridge là bot Telegram bảo mật theo hướng allowlist, giúp bạn điều khiển `codex exec` từ điện thoại mà không cần mở VS Code hoặc shell. Bot phù hợp cho workflow remote/mobile: chọn repo, chat tự nhiên với Codex, cho Codex đọc/sửa code có kiểm soát, chạy verify/test nền, xem diff, tạo handoff và thao tác PR/commit qua nút xác nhận.

## Tính năng chính

- Chỉ nhận lệnh từ Telegram user ID, và tuỳ chọn chat ID, đã được allowlist.
- Chỉ cho truy cập workspace nằm trong `WORKSPACE_ALLOWLIST`, có kiểm tra `realpath` để chặn symlink escape.
- Mặc định chạy Codex ở sandbox `read-only`; write mode cần `ALLOW_WRITE_MODE=true` và xác nhận từ Telegram.
- Write mode có TTL tự hết hạn qua `WRITE_MODE_TTL_MS`, và có thể giới hạn theo alias bằng `WRITE_REPO_ALIASES`.
- Hỗ trợ repo alias, repo mặc định theo chat, state qua restart, repo notes, queue task, stop task, heartbeat và audit log.
- Hỗ trợ `/test`, `/checks`, `/run <name>`, verify queue và auto loop Codex -> verify -> Codex khi verify fail.
- Hỗ trợ gửi ảnh Telegram vào Codex bằng `--image` khi cấu hình `ATTACHMENT_DIR`.
- Có helper cho diff, changed files, summary, review, branch, commit, PR-ready, PR-create và build/gửi Flutter APK.
- Có dashboard JSON local tuỳ chọn tại `/health` và `/sessions`.

## Yêu cầu

- Node.js `>=12`.
- `npm` để chạy script trong `package.json`.
- Codex CLI đã cài và đăng nhập trên máy chạy bot (`CODEX_BIN` mặc định là `codex`).
- Telegram bot token từ `@BotFather`.
- Một hoặc nhiều repo nằm trong thư mục được khai báo ở `WORKSPACE_ALLOWLIST`.

## Cài đặt nhanh

```bash
cd codex-telegram-bridge
cp .env.example .env
```

Sửa `.env` tối thiểu:

```env
TELEGRAM_BOT_TOKEN=123456:replace-me
TELEGRAM_ALLOWED_USER_IDS=123456789
WORKSPACE_ALLOWLIST=/home/dev/projects
REPO_ALIASES=chess=/home/dev/projects/chess-app
DEFAULT_WORKSPACE=/home/dev/projects/chess-app
```

Nếu muốn Codex được sửa file sau khi bạn xác nhận trên Telegram:

```env
ALLOW_WRITE_MODE=true
WRITE_REPO_ALIASES=chess
```

Chạy bot:

```bash
./run.sh
```

Sau khi bot start, mở Telegram và gửi:

```text
/start
/repo chess
/status
```

## Lấy Telegram user ID

1. Tạo bot với `@BotFather` bằng `/newbot`, lấy token và đặt vào `TELEGRAM_BOT_TOKEN`.
2. Chat với `@userinfobot` để lấy numeric user ID.
3. Đặt ID đó vào `TELEGRAM_ALLOWED_USER_IDS`, ví dụ `TELEGRAM_ALLOWED_USER_IDS=123456789`.
4. Nếu muốn khoá theo chat cụ thể, đặt thêm `TELEGRAM_ALLOWED_CHAT_IDS=123456789`; để trống nếu chỉ cần khoá theo user ID.

## Script vận hành

```bash
./run.sh start            # load .env, chạy doctor, rồi start bot
./run.sh doctor           # kiểm tra cấu hình và in health report
./run.sh setup-telegram   # đăng ký menu lệnh màu xanh của Telegram
./run.sh test             # chạy regression test local
./run.sh check            # syntax check một số file chính + npm test
SKIP_DOCTOR=1 ./run.sh start
```

Các script npm tương ứng:

```bash
npm start
npm test
npm run doctor
npm run setup-telegram
```

## Cấu hình `.env`

`.env.example` chứa cấu hình tối thiểu, `.env.advanced.example` chứa cấu hình đầy đủ hơn cho profile, verify, dashboard, attachments và audit.

### Bắt buộc

- `TELEGRAM_BOT_TOKEN`: token từ `@BotFather`.
- `TELEGRAM_ALLOWED_USER_IDS`: danh sách Telegram user ID dạng số, phân tách bằng dấu phẩy.
- `WORKSPACE_ALLOWLIST`: một hoặc nhiều thư mục cha mà bot được phép truy cập, phân tách bằng dấu phẩy.

### Nên cấu hình

- `REPO_ALIASES`: alias ngắn cho repo, ví dụ `chess=/home/dev/projects/chess-app`.
- `DEFAULT_WORKSPACE`: repo mặc định cho chat mới hoặc khi chưa chọn repo.
- `ALLOW_WRITE_MODE=true`: bật khả năng xin write mode từ Telegram.
- `WRITE_REPO_ALIASES=chess`: chỉ cho các alias này vào write mode; để trống nghĩa là mọi repo allowlisted đều có thể xin write nếu server bật write.
- `SESSION_STATE_PATH`: lưu repo, verbose và Codex thread ID theo chat qua restart; mode luôn khôi phục về `read-only`.
- `AUDIT_LOG_PATH`: ghi JSONL audit cho chọn repo, đổi mode, prompt, verify và helper command.
- `ATTACHMENT_DIR`: thư mục tạm để lưu ảnh Telegram trước khi truyền cho Codex.

### Codex và sandbox

- `CODEX_BIN`: binary Codex, mặc định `codex`.
- `DEFAULT_CODEX_MODE=read|write`: mặc định là `read`; `write` yêu cầu `ALLOW_WRITE_MODE=true`.
- `CODEX_RESUME_LAST=true`: dùng thread ID đã lưu hoặc `codex exec resume --last --json` để follow-up giữ context tốt hơn.
- `CODEX_SKIP_GIT_REPO_CHECK=true`: thêm `--skip-git-repo-check`; chỉ nên dùng cho thư mục nháp không phải git repo.
- `CODEX_SHOW_COMMAND_EVENTS=true`: bật hiển thị command execution event mặc định; cũng có thể bật/tắt từng chat bằng `/verbose on|off`.
- `CODEX_EXTRA_ARGS=/absolute/path/to/args.json`: file JSON array chứa tham số bổ sung cho Codex, ví dụ `["--model","gpt-5.2"]`.

### Verify và profile

- `TEST_COMMANDS`: override lệnh `/test` theo alias, ví dụ `TEST_COMMANDS='chess=flutter test,*=npm test'`.
- Nếu không có override, `/test` tự dò `npm/pnpm/yarn/bun test`, Flutter/Dart, Deno, Gradle, Maven, Go, Cargo, pytest hoặc `make test`.
- `REPO_PROFILES_JSON`: cấu hình `cwd`, `notesPath`, `testCommand`, `checksCommand`, `rerunFailedCommand`, `prCreateCommand`, `defaultPrompt` và `commands` theo repo alias.
- `VERIFY_PROFILES_JSON`: cấu hình verify nền theo alias hoặc tên profile, có thể trỏ `cwd` vào module con như `mobile` hoặc `backend`.
- `AUTO_LOOP_DEFAULT=true`: tự bật vòng Codex -> verify -> Codex cho prompt có vẻ cần sửa code.
- `MAX_AUTO_LOOP_ATTEMPTS=3`: giới hạn số lần auto retry khi verify fail.
- `WORKSPACE_COMMAND_TIMEOUT_MS=120000`: timeout cho helper command/verify local shell.

Ví dụ profile ngắn:

```env
REPO_PROFILES_JSON='{"chess":{"cwd":"mobile","notesPath":".codex-telegram/context.md","testCommand":"flutter test","checksCommand":"flutter analyze && flutter test","rerunFailedCommand":"flutter test","prCreateCommand":"gh pr create --fill","defaultPrompt":"You are working on a Flutter chess app. Keep changes small.","commands":{"Analyze":"flutter analyze","Test":"flutter test","Build APK":"flutter build apk --split-per-abi"}}}'
VERIFY_PROFILES_JSON='{"chess":{"cwd":"mobile","command":"flutter test","successText":"Flutter tests passed."}}'
```

### Dashboard và attachments

- `DASHBOARD_HOST=127.0.0.1` và `DASHBOARD_PORT=8787`: bật dashboard local tại `http://127.0.0.1:8787/health` và `/sessions`.
- `ATTACHMENT_DIR=/tmp/codex-telegram-bridge-attachments`: bật nhận ảnh Telegram.
- `ATTACHMENT_MAX_AGE_MS=86400000`: tuổi file ảnh tạm trước khi `/cleanup` xoá.

## Lệnh Telegram

### Cơ bản

- `/start` hoặc `/help`: onboarding, nút chọn repo và danh sách lệnh.
- `/repos`: liệt kê repo alias từ `REPO_ALIASES`.
- `/repo <alias-or-absolute-path>`: chọn workspace; path tuyệt đối phải nằm trong `WORKSPACE_ALLOWLIST`.
- `/set-default <alias>` hoặc `/set_default <alias>`: lưu repo mặc định cho chat.
- `/status`: xem workspace, mode, workflow, queue, verify, pending plan/commit, repo notes và verbose.
- `/health`: in health report cấu hình.
- `/stop`: gửi `SIGTERM` cho Codex task đang chạy.
- `/reset-task`, `/reset_task`, `/new`, `/clear`: xoá state phiên hiện tại và khởi tạo context mới tinh cho chat.

### Mode và task

- `/mode read`: chuyển Codex về sandbox `read-only`.
- `/mode write`: xin bật `workspace-write`; bot sẽ hỏi xác nhận trước khi bật.
- `/work 10m` hoặc `/work 30m`: bật write window tạm thời, tối đa 120 phút.
- `/ask <prompt>`: chạy Codex một lần; gửi text bình thường cũng tương đương `/ask`.
- `/continue`: tiếp tục prompt gần nhất.
- `/queue`: xem số task đang chờ.
- `/cancel-queue` hoặc `/cancel_queue`: xoá các task đang chờ.
- `/autoloop on|off`: bật/tắt tự động fix -> verify -> retry.
- `/verbose on|off`: bật/tắt hiển thị command execution event của Codex trong chat.

### Code review, verify và handoff

- `/diff`: chạy `git diff --stat`.
- `/files`: chạy `git status --short`.
- `/test`: enqueue verify mặc định cho repo hiện tại.
- `/run <name>`: enqueue command trong `REPO_PROFILES_JSON.commands`.
- `/checks`: enqueue `checksCommand` hoặc command profile tên `Checks`, `CI Checks`, `PR Checks`.
- `/rerun-failed` hoặc `/rerun_failed`: chạy `rerunFailedCommand`, command profile tương ứng, hoặc rerun verify fail gần nhất.
- `/codex-last`, `/codex_last`, `/fix-last`, `/fix_last`: gửi output verify/helper command gần nhất lại cho Codex để sửa tiếp.
- `/review`: yêu cầu Codex review diff hiện tại ở read-only, không sửa file.
- `/summary` hoặc `/done`: tạo handoff ngắn gồm thay đổi, files, verify mới nhất, rủi ro và mức sẵn sàng commit.
- `/plan <task>`: yêu cầu Codex lập plan read-only, sau đó dùng nút `Approve & Run`, `Revise Plan`, hoặc `Cancel`.

### Git, PR, notes và APK

- `/note <text>`: lưu repo memory vào `notesPath`, mặc định `.codex-telegram/context.md`.
- `/branch <name>`: tạo branch bằng `git checkout -b`; cần write mode đã xác nhận.
- `/commit <message>`: tạo pending commit và chỉ chạy `git commit -m` sau khi bấm xác nhận; cần write mode.
- `/pr-ready` hoặc `/pr_ready`: nhờ Codex tạo PR-ready summary từ diff/status/log và verify gần nhất.
- `/pr-create` hoặc `/pr_create`: chạy `prCreateCommand` hoặc profile command `Create PR`/`PR Create`/`Open PR`; nếu chưa cấu hình, bot gợi ý dùng `/pr-ready`.
- `/apk`: build Flutter APK bằng profile command `Build APK`/`APK`/`Flutter APK` hoặc fallback `flutter build apk --split-per-abi`, rồi gửi file `.apk` qua Telegram; cần write mode.
- `/logs`: xem 20 dòng audit gần nhất nếu có `AUDIT_LOG_PATH`.
- `/cleanup`: xoá attachment cũ theo `ATTACHMENT_MAX_AGE_MS`.

## Workflow gợi ý

### Sửa code an toàn từ điện thoại

1. Chọn repo bằng `/repo <alias>`.
2. Gửi yêu cầu dạng tự nhiên, ví dụ `sửa lỗi login timeout và chạy test liên quan`.
3. Nếu bot phát hiện task có khả năng sửa code, bấm `Enable write & run` hoặc dùng `/mode write` rồi xác nhận.
4. Sau khi Codex xong, bấm `Test`, `Diff`, `Files`, `Summary` hoặc `Fix last output`.
5. Khi ổn, dùng `/commit <message>` hoặc `/pr-ready`.

### Chat-only agent với auto loop

1. Đặt `AUTO_LOOP_DEFAULT=true` hoặc bật `/autoloop on`.
2. Đảm bảo `/test` hoặc `VERIFY_PROFILES_JSON` chạy đúng từ repo/module hiện tại.
3. Gửi task sửa code; khi Codex xong, bridge tự enqueue verify.
4. Nếu verify fail, bridge gửi output fail lại cho Codex cho tới khi pass hoặc chạm `MAX_AUTO_LOOP_ATTEMPTS`.

### Làm việc với screenshot

1. Đặt `ATTACHMENT_DIR` trong `.env`.
2. Gửi ảnh kèm caption để truyền cả ảnh và text vào Codex.
3. Nếu gửi ảnh không caption, bot hiển thị nút `Review UI`, `Find bug`, `Implement similar screen`, `Attach only`.
4. File ảnh tạm có thể xoá bằng `/cleanup`.

## Mô hình bảo mật

- Bot bỏ qua mọi user không nằm trong `TELEGRAM_ALLOWED_USER_IDS`.
- Nếu `TELEGRAM_ALLOWED_CHAT_IDS` không rỗng, chat ID cũng phải khớp allowlist.
- Workspace và profile `cwd` không được escape khỏi allowlist/workspace.
- Codex chỉ chạy với `--sandbox read-only` hoặc `--sandbox workspace-write`; project không dùng `danger-full-access`.
- Write mode không tự khôi phục sau restart hoặc sau khi đổi repo.
- Token và secret-like values được redact khỏi outbound message/log.
- Env truyền cho Codex được lọc, không truyền `TELEGRAM_BOT_TOKEN`; chỉ giữ các biến an toàn/cần thiết như `HOME`, `PATH`, `CODEX_HOME`, `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GEMINI_API_KEY`, `GOOGLE_API_KEY`.
- Telegram message bị giới hạn độ dài qua `MAX_PROMPT_CHARS` và chặn control characters.
- Command verify/helper chạy từ bridge process với env hiện tại, nên chỉ cấu hình command bạn tin tưởng trong `.env`.

## Vận hành production

- Chạy `npm run doctor` hoặc `./run.sh doctor` trước khi start service.
- Dùng `deploy/codex-telegram-bridge.service` làm mẫu systemd service; chỉnh `WorkingDirectory`, `EnvironmentFile` và `ExecStart` theo đường dẫn triển khai thật.
- Bật `AUDIT_LOG_PATH` để có `/logs` và trail JSONL.
- Bật `DASHBOARD_PORT` nếu cần endpoint local cho health/session snapshot; mặc định dashboard tắt.
- Giữ `WORKSPACE_ALLOWLIST` hẹp, ví dụ `/home/dev/projects`, không đặt `/`.
- Giữ `CODEX_SHOW_COMMAND_EVENTS=false` cho chat sạch; chỉ dùng `/verbose on` khi debug.

## Lỗi thường gặp

- `401 Unauthorized` hoặc `token_invalidated`: chạy `codex login` trên máy chạy bot rồi restart bot.
- `429 Too Many Requests`: chờ rate limit, giảm queue hoặc đổi model qua `CODEX_EXTRA_ARGS` nếu đã cấu hình.
- `Not inside a trusted directory`: chọn repo git thật bằng `/repo <alias>`; chỉ bật `CODEX_SKIP_GIT_REPO_CHECK=true` cho scratch folder có chủ đích.
- `Workspace is not allowlisted`: kiểm tra path repo nằm dưới `WORKSPACE_ALLOWLIST` và không đi qua symlink ra ngoài.
- Write bị từ chối: kiểm tra `ALLOW_WRITE_MODE=true`, alias có trong `WRITE_REPO_ALIASES`, rồi dùng `/mode write` hoặc `/work 30m`.
- Không nhận ảnh: cấu hình `ATTACHMENT_DIR` và đảm bảo bot có quyền ghi thư mục đó.
- Lỗi `bwrap` hoặc permission denied trên Ubuntu 24.04+: xem `docs/ubuntu-bwrap-fix.md`.

## Tài liệu thêm

- `docs/remote-android-ui.md`: hướng dẫn preview/control Android Emulator hoặc device từ browser.
- `docs/ubuntu-bwrap-fix.md`: hướng dẫn xử lý lỗi `bwrap`/AppArmor trên Ubuntu.
- `docs/superpowers/plans/`: các plan/roadmap lịch sử cho tính năng bot.
