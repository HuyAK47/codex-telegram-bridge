# Hướng dẫn Xem và Điều khiển Giao diện Android Từ xa qua Web (`ws-scrcpy`)

Tài liệu này hướng dẫn cách cài đặt và sử dụng **`ws-scrcpy`** để truyền màn hình thiết bị Android (hoặc Emulator) lên trình duyệt Web. Giải pháp này giúp bạn xem trực tiếp giao diện ứng dụng Flutter và tương tác thử nghiệm từ xa trong quá trình phát triển mã nguồn cùng Codex qua Telegram.

---

## 📋 Yêu cầu chuẩn bị

1. **Thiết bị Android:**
   - Nếu dùng thiết bị thật: Đã bật **USB Debugging** (Gỡ lỗi USB) trong phần *Cài đặt cho nhà phát triển*.
   - Nếu dùng máy ảo: Khởi động sẵn **Android Emulator** trên máy host.
2. **Kiểm tra kết nối ADB:**
   Mở terminal trên máy host và chạy lệnh:
   ```bash
   adb devices
   ```
   Đảm bảo thiết bị của bạn hiển thị trong danh sách với trạng thái `device`.

---

## 🛠️ Hướng dẫn cài đặt

Bạn có thể chạy `ws-scrcpy` bằng một trong hai phương pháp dưới đây:

### Cách 1: Chạy bằng Docker (Khuyên dùng - Nhanh & Ổn định)

Sử dụng Docker giúp tránh các lỗi liên quan đến việc biên dịch thư viện C++ (`node-pty`) trên hệ điều hành host.

Chạy lệnh sau trên máy host của bạn để khởi động dịch vụ:

```bash
docker run --name ws-scrcpy -d \
  --privileged \
  -v /dev/bus/usb:/dev/bus/usb \
  --net=host \
  n1n3b1t/ws-scrcpy:latest
```

*Trong đó:*
- `--privileged` và `-v /dev/bus/usb:/dev/bus/usb`: Cho phép container truy cập và điều khiển các thiết bị Android cắm qua cổng USB.
- `--net=host`: Giúp container kết nối trực tiếp với dịch vụ `adb daemon` (cổng `5037`) đang chạy trên máy host.

---

### Cách 2: Chạy trực tiếp bằng NPM (Node.js)

Phương pháp này phù hợp nếu bạn muốn chạy nhẹ nhàng mà không cần cài đặt Docker.

1. **Cài đặt các gói phụ thuộc trên Ubuntu:**
   ```bash
   sudo apt update
   sudo apt install android-tools-adb scrcpy build-essential git
   ```

2. **Tải mã nguồn và cài đặt:**
   ```bash
   git clone https://github.com/NetrisTV/ws-scrcpy.git
   cd ws-scrcpy
   npm install
   ```

3. **Khởi động dịch vụ:**
   ```bash
   npm start
   ```

---

## 💻 Hướng dẫn sử dụng

1. **Truy cập giao diện Web:**
   Mở trình duyệt trên máy tính cá nhân hoặc điện thoại của bạn và truy cập địa chỉ:
   - Nếu truy cập từ chính máy host: `http://localhost:8000`
   - Nếu truy cập từ thiết bị khác trong cùng mạng LAN: `http://<IP-máy-host>:8000`

2. **Bắt đầu điều khiển:**
   - Trên giao diện Web, bạn sẽ thấy danh sách các thiết bị đang kết nối.
   - Nhấp vào thiết bị của bạn để mở cửa sổ điều khiển.
   - Bạn có thể dùng **chuột** để chạm/vuốt màn hình và sử dụng **bàn phím** máy tính để nhập liệu trực tiếp vào thiết bị.

---

## 🌐 Truy cập từ xa qua Internet (Sử dụng Ngrok)

Nếu bạn muốn xem và điều khiển màn hình thiết bị Android từ xa khi đang ở ngoài (không chung mạng LAN với máy host), bạn có thể sử dụng **Ngrok** để NAT cổng `8000` của `ws-scrcpy` ra ngoài Internet:

1. **Cài đặt Ngrok trên máy host (Ubuntu):**
   ```bash
   curl -s https://ngrok-agent.s3.amazonaws.com/files.pub.key | sudo gpg --dearmor -o /usr/share/keyrings/ngrok.gpg
   echo "deb [signed-by=/usr/share/keyrings/ngrok.gpg] https://ngrok-agent.s3.amazonaws.com buster main" | sudo tee /etc/apt/sources.list.d/ngrok.list
   sudo apt update && sudo apt install ngrok
   ```

2. **Cấu hình tài khoản Ngrok:**
   Đăng ký tài khoản miễn phí tại [ngrok.com](https://ngrok.com), sao chép mã `Authtoken` và chạy lệnh cấu hình trên máy host:
   ```bash
   ngrok config add-authtoken <MÃ_AUTHTOKEN_CỦA_BẠN>
   ```

3. **NAT cổng 8000 của `ws-scrcpy` ra ngoài Internet:**
   Chạy lệnh sau trên máy host:
   ```bash
   ngrok http 8000
   ```

4. **Truy cập:**
   Ngrok sẽ trả về một đường dẫn công khai bảo mật có dạng: `https://xxxx-xxxx-xxxx.ngrok-free.app`. Bạn chỉ cần truy cập vào đường dẫn này từ trình duyệt trên điện thoại hoặc máy tính cá nhân ở bất kỳ đâu để bắt đầu điều khiển thiết bị từ xa.

---

## 🔄 Quy trình phối hợp phát triển cùng Codex

Khi bạn lập trình ứng dụng Flutter từ xa qua Telegram:

1. **Mở sẵn luồng stream:** Giữ trình duyệt web chạy `ws-scrcpy` (hoặc thông qua link Ngrok) hiển thị ở một góc màn hình để theo dõi.
2. **Yêu cầu Codex sửa đổi code:** Chat với bot Telegram để yêu cầu Codex thực hiện các thay đổi mã nguồn.
3. **Chạy ứng dụng:**
   - Gửi lệnh `/test` hoặc `/run Flutter Test` (hoặc lệnh chạy app nếu bạn có cấu hình riêng) qua Telegram để kích hoạt chạy ứng dụng trên Emulator.
   - Ứng dụng sẽ tự động khởi động và hiển thị trên màn hình stream của trình duyệt web.
4. **Xem kết quả:** Bạn có thể kiểm tra trực tiếp giao diện và kiểm thử tính năng ngay tại chỗ mà không cần tiếp xúc trực tiếp với máy host.

---

## 📦 Tự động Build và Tải file APK trực tiếp từ Bot Telegram

Nếu bạn muốn cài đặt app trực tiếp lên điện thoại Android thật của mình để test hiệu năng thực tế (native), tôi đã tích hợp sẵn tính năng build và gửi file APK tự động ngay trên khung chat Telegram.

### Cách hoạt động:
1. Đảm bảo bạn đã chọn một workspace Flutter (chứa tệp `pubspec.yaml`).
2. Gửi lệnh `/apk` hoặc nhấp vào nút **`APK`** trên menu chính của Bot.
3. Bot sẽ tự động thực hiện:
   - Chạy lệnh `flutter build apk --split-per-abi` trên máy host.
   - Lọc và tìm các file APK đã build (thường là các file tối ưu dung lượng cho từng kiến trúc chip như `app-armeabi-v7a-release.apk` hay `app-arm64-v8a-release.apk` với dung lượng rất nhẹ chỉ khoảng 10-18 MB).
   - Tự động tải các tệp APK này lên phòng chat Telegram bằng API `sendDocument`.
4. Bạn chỉ cần nhấn vào tệp APK trong Telegram để tải về điện thoại và cài đặt trực tiếp.

