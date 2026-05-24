# Sửa lỗi Phân Quyền Đọc/Ghi (Sandbox/Bubblewrap) trên Ubuntu 24.04+

Khi sử dụng Codex ở chế độ ghi (`workspace-write`), Codex CLI sử dụng công cụ **bubblewrap (`bwrap`)** để tạo môi trường sandbox cô lập các câu lệnh shell được thực thi. 

Kể từ phiên bản **Ubuntu 24.04 (Noble Numbat)**, hệ thống mặc định giới hạn quyền tạo không gian tên người dùng không có đặc quyền (unprivileged user namespaces) thông qua AppArmor. Điều này khiến `bwrap` bị chặn và trả về lỗi:

```text
bwrap: loopback: Failed RTM_NEWADDR: Operation not permitted
```

Hệ quả là Codex không thể chạy các tác vụ ghi file (`apply_patch`), sửa đổi mã nguồn hoặc chạy thử nghiệm trong sandbox.

Dưới đây là hai phương án khắc phục lỗi này.

---

## Cách 1: Cấu hình sysctl tắt giới hạn hệ thống (Nhanh & Đơn giản nhất)

Phương án này vô hiệu hóa giới hạn tạo namespace của AppArmor trên toàn hệ thống. Đây là cách thuận tiện nhất cho môi trường phát triển cá nhân, giúp tránh được các lỗi phân quyền phức tạp khi làm việc trên phân vùng gắn ngoài (như `/media` hoặc `/mnt`).

### Tạm thời (mất hiệu lực sau khi khởi động lại):
```bash
sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0
```

### Lâu dài (tự động áp dụng khi khởi động lại):
Chạy lệnh sau để lưu cấu hình vĩnh viễn vào hệ thống:
```bash
echo "kernel.apparmor_restrict_unprivileged_userns=0" | sudo tee /etc/sysctl.d/60-apparmor-namespace.conf
sudo sysctl --system
```

---

## Cách 2: Cấu hình AppArmor cho phép `bwrap` (Bảo mật hơn)

Đây là phương án tốt về mặt bảo mật vì nó chỉ mở rộng đặc quyền riêng cho ứng dụng `bwrap` mà không làm giảm mức độ bảo mật chung của toàn hệ thống.

### Bước 1: Tạo tệp cấu hình AppArmor cho `bwrap`
Mở terminal và tạo tệp cấu hình mới:

```bash
sudo nano /etc/apparmor.d/bwrap
```

### Bước 2: Dán nội dung cấu hình
Sao chép đoạn cấu hình dưới đây và dán vào tệp:

```text
abi <abi/4.0>,
include <tunables/global>

profile bwrap /usr/bin/bwrap flags=(unconfined) {
  userns,
  include if exists <local/bwrap>
}
```

*Nhấn `Ctrl + O` -> `Enter` để lưu và `Ctrl + X` để thoát.*

### Bước 3: Nạp lại cấu hình AppArmor
Chạy lệnh sau để hệ thống áp dụng cấu hình mới ngay lập tức:

```bash
sudo systemctl reload apparmor
```

> [!WARNING]
> **Lưu ý đối với phân vùng ngoài (`/media/**`, `/mnt/**` hoặc ổ đĩa ảo Veracrypt/FUSE):**
> Khi áp dụng Cách 2, AppArmor tuy cho phép `bwrap` khởi tạo sandbox nhưng các tiến trình con bên trong sandbox vẫn có thể bị chặn ghi đối với các phân vùng gắn ngoài (chỉ đọc được mà không ghi được). 
> Nếu gặp hiện tượng này, giải pháp tốt nhất là sử dụng **Cách 1 (Lâu dài)** hoặc di chuyển Workspace vào thư mục Home của bạn (ví dụ `/home/user/projects/...`).

---

## Kiểm tra lại hoạt động của Bot

Sau khi áp dụng một trong hai cách trên, bạn có thể khởi động lại bot Telegram và thử nghiệm chế độ ghi bằng cách gửi tin nhắn:

1. Chuyển sang chế độ ghi: `/mode write` hoặc kích hoạt thời gian ghi `/work 30m`.
2. Gửi yêu cầu thay đổi file, ví dụ: `"Tạo file test.txt chứa nội dung hello"`.
3. Kiểm tra xem file đã được tạo thành công trong repository hay chưa.
