# FLC — Nền tảng Order dịch vụ đa vai trò

FLC kết nối **Khách hàng** với mạng lưới **Freelancer** (Referrer, Sales, Account, PM, Project) dưới sự kiểm duyệt của **M&T Group**. Một Order không phải là "đăng lên → ai nhận trước làm". Order đi qua quy trình 7 bước có điều kiện chuyển bước, phân công theo vai trò, sổ doanh thu và hoa hồng riêng.

Đây là bản **MVP (Giai đoạn 1)**, gồm ba khu vực giao diện:
- **Customer Portal** (`/customer`)
- **Freelancer Portal** (`/fl`)
- **M&T Admin** (`/admin`)

## Chạy thử trong 2 phút

Cần **Node.js ≥ 22.13** (đã thử trên Node 24). Không cần cài cơ sở dữ liệu vì dự án dùng `node:sqlite` có sẵn trong Node.

```bash
npm install
```

```bash
npm run seed -- --reset
```

```bash
npm start
```

Mở http://localhost:3000.

### Tài khoản demo

Danh sách đầy đủ nằm ở đầu tệp [scripts/seed.js](scripts/seed.js). Tóm tắt:

| Vai trò | Đăng nhập | Ghi chú |
|---|---|---|
| M&T Admin | `admin@flc.local` | Mật khẩu là biến `FLC_ADMIN_PASSWORD`, hoặc giá trị mặc định ghi trong seed.js |
| Khách hàng | `khach.an@demo.local`, `khach.binh@demo.local` | `khach.moi@…` đang chờ duyệt |
| Freelancer | `referrer@`, `sales@`, `account@`, `pm@`, `project1@`, `project2@` (`@demo.local`) | `da.vai.tro@…` (Referrer + Sales) đang chờ duyệt |
| Coder web | `coder@demo.local` | Nhận 4% trên mọi Order. Xem tại trang *Doanh thu & dự án* |

Dữ liệu demo có sẵn các Order ở các giai đoạn khác nhau:

| Order | Trạng thái | Đặc điểm |
|---|---|---|
| ORD1 | Đã đóng | Đi trọn quy trình: có Referrer, có PM, 2 Project chia 60/40, đã chi trả một phần |
| ORD2 | Đang kiểm duyệt | Không có Referrer, không có PM (Account kiêm PM), đã đối soát đợt cọc |
| ORD3 | Báo giá | Chờ khách xác nhận |
| ORD4 | Chờ tiếp nhận | Chờ Sales nhận |
| ORD5 | Bản nháp | |

> ⚠️ Mật khẩu demo chỉ dùng cho môi trường phát triển. Không chạy `seed` trên production.

## Lệnh

| Lệnh | Tác dụng |
|---|---|
| `npm start` | Chạy server (cổng `PORT`, mặc định 3000) |
| `npm run dev` | Chạy và tự khởi động lại khi sửa code (`node --watch`) |
| `npm run seed -- --reset` | Xóa CSDL và tệp đã tải lên, rồi tạo lại dữ liệu demo |
| `npm test` | 19 bài kiểm thử: thuật toán hoa hồng, doanh thu thuần, bảng tỷ lệ và các quy tắc hệ thống |

## Cấu trúc

```
src/
  server.js            Express app: bảo mật header, session, CSRF, định tuyến
  middleware.js        loadUser, requireKind, requireActive, act() (bọc lỗi nghiệp vụ → flash)
  db/schema.sql        Toàn bộ bảng + trigger khóa dữ liệu tài chính và nhật ký
  db/index.js          node:sqlite, tx() (transaction BEGIN IMMEDIATE)
  services/            ★ Toàn bộ quy tắc nghiệp vụ nằm ở đây — route chỉ gọi service
    orderFlow.js       Máy trạng thái 20 trạng thái + điều kiện chuyển bước
    assignment.js      Tiếp nhận, mời, nhận/từ chối, duyệt & khóa phân công
    orders.js          Order, báo giá, hợp đồng, nhiệm vụ, bàn giao, nghiệm thu
    finance.js         Khai báo / xác nhận thực thu, hoàn tiền, tự chuyển bước theo tiền
    commission.js      Đối soát, duyệt, chi trả, tỷ lệ, người nhận Coder web
    revenue.js         Doanh thu & thu nhập theo từng dự án của freelancer
    access.js          Ai được xem Order nào, phần nào
    files.js           Upload vào storage/private + quyền tải (file gốc / demo / CCCD)
    accounts.js        Đăng ký, đăng nhập, M&T duyệt tài khoản & vai trò
    reports.js         Truy vấn dashboard & báo cáo (SQL dạng CTE)
  routes/              public · customer · freelancer · orders (dùng chung) · admin · files
  lib/                 labels (nhãn + màu trạng thái), fmt, password (scrypt), icons, session-store
views/                 EJS — order/show.ejs là trang Order dùng chung cho mọi vai trò
public/css/flc.css     Design system (token + component)
public/js/revenue-core.js  ★ Công thức doanh thu thuần + chia hoa hồng, dùng chung cho server và trình duyệt
docs/                  SYSTEM_DESIGN.md · DESIGN_SYSTEM.md
test/                  node:test
```

## Quy tắc hệ thống: được thực thi ở đâu

| Quy tắc | Thực thi tại |
|---|---|
| Chưa đạt điều kiện đặt cọc thì không được triển khai (trừ khi M&T duyệt ngoại lệ, có lý do) | `orderFlow.guard('DEPOSITED' / 'MATCHING')`, `orders.depositException` |
| Chưa thanh toán đủ thì không được tải file gốc | `files.resolve('deliverable')` kiểm tra `finance.summary().paidInFull` |
| Demo/preview chỉ xem trực tiếp, không cache | `routes/files.js` gửi header `inline` + `no-store` |
| Order hoàn tất không tự chia doanh thu | Hoa hồng chỉ được tạo khi Admin bấm *Đối soát* (`commission.reconcile`) |
| Không có Referrer thì phần 5% về M&T | `computeLines`, dòng `beneficiary = 'MT'` |
| Một người nhiều vai trò: cộng từng vai trò, không ghi trùng | Ràng buộc `UNIQUE(payment_id, beneficiary, role)` |
| Một vai trò có nhiều người: chia theo tỷ lệ phân công | `share_bp` trong `order_assignments` |
| Hoa hồng tính theo từng đợt thu | Mỗi `payment` được đối soát riêng |
| Tỷ lệ lưu theo Order, chính sách mới không ảnh hưởng Order đã chốt | `revenue_allocations` chụp tỷ lệ lúc M&T khóa phương án |
| Không sửa dữ liệu tài chính đã chốt | Trigger `payments_locked`, `commissions_locked`, `commissions_no_delete` |
| Nhật ký bất biến | Trigger `audit_no_update`, `audit_no_delete` |
| Freelancer không tự sửa tỷ lệ | Chỉ route `/admin/*` (yêu cầu `kind = admin`) mới ghi tỷ lệ |
| Không để hai người cùng nhận một vị trí độc quyền | `assignment.respond` + transaction `BEGIN IMMEDIATE` |
| Order phải có người phụ trách chính và người dự phòng | Account là phụ trách chính. M&T là dự phòng mặc định và có thể thu hồi hoặc thay người |
| Freelancer chỉ xem thông tin cần thiết; quyền bị thu hồi khi Order đóng | `access.forOrder` (thông tin liên hệ khách chỉ hiện với Sales/Account, thông tin hóa đơn chỉ hiện với Admin) |
| Phân biệt hoa hồng dự kiến và khoản thực trả | `revenue.forUser` (trang `/fl/revenue`) chỉ tính để hiển thị. Khoản thực trả nằm ở sổ `commissions` (trang `/fl/earnings`) |
| Bộ tính và đối soát dùng cùng một công thức | `public/js/revenue-core.js` được dùng chung cho cả server lẫn trình duyệt |
| Phần Coder web 4% tính trên mọi Order | `commission.lockedHolders` thêm `DEV` từ `settings.dev_user_id`. Chưa cấu hình thì M&T giữ lại |

## Bảo mật đã có

- Mật khẩu băm bằng `scrypt` kèm salt riêng cho từng tài khoản.
- Phiên đăng nhập lưu trong SQLite, cookie `httpOnly` + `SameSite=Lax` (thêm `Secure` khi chạy production). Phiên được tạo lại sau khi đăng nhập.
- CSRF token cho mọi POST. Form multipart gửi token qua query `?_csrf=`.
- CSP chặn mọi script ngoài và script inline. Có thêm `X-Frame-Options`, `nosniff`.
- Tệp tải lên được đổi sang tên ngẫu nhiên, lưu ngoài thư mục public. Ảnh CCCD chỉ nhận định dạng ảnh, giới hạn 25MB mỗi tệp.
- Mọi truy vấn SQL đều tham số hóa.

## Triển khai production

1. Đặt biến môi trường: `NODE_ENV=production`, `SESSION_SECRET` (chuỗi ngẫu nhiên dài), `PORT`. Tùy chọn thêm `FLC_DB` (đường dẫn tệp CSDL) và `FLC_STORAGE` (thư mục lưu tệp).
2. Chạy sau một reverse proxy có HTTPS (Nginx hoặc Caddy). App đã bật `trust proxy`.
3. Tạo tài khoản Admin đầu tiên. Hiện có thể chạy seed rồi xóa dữ liệu demo; nên viết script `create-admin` riêng.
4. Sao lưu định kỳ hai thư mục `data/` và `storage/private/`.
5. Khi tải lớn hơn: chuyển sang PostgreSQL (schema đã viết theo chuẩn, xem ghi chú đầu `schema.sql` và `reports.js`), chuyển tệp sang S3/R2. Chi tiết ở [docs/SYSTEM_DESIGN.md §7](docs/SYSTEM_DESIGN.md).

## M&T cần chốt

Code đang chạy theo các giả định dưới đây. Mỗi giả định nằm ở một chỗ cụ thể nên dễ đổi. Bảng đầy đủ ở [docs/SYSTEM_DESIGN.md §1.4](docs/SYSTEM_DESIGN.md).

1. **Phân công:** Account mời theo năng lực, người chấp nhận trước giữ chỗ (với PM). Sales nhận Order theo kiểu ai nhận trước được trước.
2. **Dòng tiền:** khách trả cho M&T, M&T chi lại cho freelancer.
3. **Hoa hồng:** tính theo từng đợt thực thu, trên doanh thu thuần.
4. **Tỷ lệ (đã chốt, bảng "Full"):** Referrer 5 · Sales 10 · Account 5 · PM 10 · Project 40 · Coder web 4 · M&T 26 (%). Chỉnh tỷ lệ và chọn người nhận phần Coder web tại `/admin/rates`.
5. **"Chuẩn ECO":** hiện được hiểu là hệ sinh thái nhiều vai trò, kết hợp giao diện nhẹ.

## Chưa có trong MVP (lộ trình V2/V3)

- OTP qua SMS/email, quên mật khẩu.
- Cổng thanh toán VNPay/MoMo (hiện Admin xác nhận chuyển khoản thủ công).
- Thông báo qua email/Zalo (hiện chỉ có thông báo trong web).
- Nhắc hạn "2 giờ hành chính" tự động.
- Watermark cho bản demo.
- Đánh giá và xếp hạng freelancer, tự động ghép nhân sự (V2), marketplace (V3).
