# FLC — Thiết kế hệ thống (MVP · Giai đoạn 1)

> Phiên bản 0.1 · 27/10/2026 · Trạng thái: **bản nháp chờ M&T chốt các giả định ở mục 1.4**

FLC là nền tảng kết nối **Khách hàng** với **mạng lưới Freelancer** (Referrer, Sales, Account, PM, Project) dưới sự kiểm duyệt của **M&T Group**. Hệ thống không vận hành theo kiểu "đăng Order → tự nhận việc", mà theo một quy trình có kiểm soát gồm 7 bước, có sổ doanh thu và hoa hồng tách riêng theo từng vai trò.

---

## 1. Yêu cầu

### 1.1 Chức năng

| Nhóm | Yêu cầu |
|---|---|
| Tài khoản | Customer đăng ký bằng SĐT hoặc Gmail + mật khẩu. Freelancer đăng ký đủ hồ sơ (họ tên, ngày sinh, SĐT, Gmail, mật khẩu, CV, CCCD 2 mặt, số tài khoản, mã thành viên tự đặt, sản phẩm đã làm, kỹ năng). Admin duyệt / yêu cầu bổ sung / từ chối / tạm dừng. |
| Mã tự sinh | `CUS1…`, `FL1…`, `ORD1…`, `PROJ1…`, sinh tuần tự, không trùng, không tái sử dụng. |
| Order | Đăng Order (có bản nháp), đính kèm tệp. Thông tin hóa đơn chỉ Admin xem được. Order đi qua các trạng thái ở mục 3. |
| Báo giá & hợp đồng | Báo giá có nhiều phiên bản. Khách xác nhận báo giá. Hợp đồng ghi giá trị, tỷ lệ cọc và số tiền phải thu. |
| Phân công | Account ghép Project, có thể ghép thêm PM. Mời theo năng lực, người chấp nhận lời mời trước được ưu tiên. Admin duyệt và **khóa** danh sách nhân sự cùng tỷ lệ. |
| Triển khai | Mỗi Order có không gian làm việc `PROJn`: nhiệm vụ, bàn giao theo phiên bản, trao đổi, tệp. Mỗi người chỉ xem được Order mình tham gia. |
| Nghiệm thu | Khách chấp nhận sản phẩm, yêu cầu sửa, hoặc yêu cầu thay đổi ngoài phạm vi. Hệ thống lưu người nghiệm thu, thời điểm và phiên bản. |
| Tài chính | Ghi nhận các đợt thanh toán, thuế, giảm trừ, hoàn tiền. Đối soát theo lệnh của Admin, rồi tính hoa hồng, duyệt, chi trả. |
| Kiểm soát | Nhật ký (AuditLog) cho mọi thao tác duyệt và mọi thay đổi tài chính. Có khiếu nại và tranh chấp. |

### 1.2 Phi chức năng

- **Quy mô MVP:** dưới 1.000 người dùng, dưới 200 Order/tháng, tối đa khoảng 50 người dùng đồng thời. Một máy chủ là đủ.
- **Toàn vẹn tài chính quan trọng hơn hiệu năng:** tiền lưu bằng số nguyên VND, mọi bút toán tài chính đều chạy trong transaction, dữ liệu tài chính đã chốt không được ghi đè.
- **Bảo mật dữ liệu cá nhân:** ảnh CCCD và số tài khoản chỉ Admin xem. Tệp gốc chỉ được phát qua route có kiểm tra quyền và điều kiện thanh toán.
- **Ngôn ngữ:** giao diện tiếng Việt, thiết kế responsive cho điện thoại.

### 1.3 Ràng buộc

- **Node.js** (đã chốt). Hạn chế phụ thuộc native để chạy được ngay trên Windows mà không cần cài thêm gì.
- **"Chuẩn ECO":** hiểu là *ecosystem*, tức một nền tảng chung cho mọi vai trò. Thiết kế cũng theo hướng nhẹ: render phía server, ít JavaScript, không dùng framework nặng.

### 1.4 Giả định đang dùng (M&T cần chốt)

| # | Vấn đề | Giả định mặc định | Nằm ở đâu trong code |
|---|---|---|---|
| A1 | Phân công | Account **mời** freelancer theo năng lực. Nếu nhiều người được mời cho cùng một vị trí độc quyền, người **chấp nhận trước** sẽ giữ chỗ và các lời mời còn lại tự hết hiệu lực. | `services/assignment.js` |
| A2 | Dòng tiền | Khách trả cho **M&T**, sau đó M&T chi trả cho freelancer qua Payout. | `services/finance.js` |
| A3 | Cơ sở hoa hồng | Tính **theo từng đợt thực thu**, trên doanh thu thuần của đợt đó. Chỉ tính khi Admin bấm *Đối soát*. | `services/commission.js` |
| A4 | Tỷ lệ mặc định (**đã chốt 28/10/2026 — bảng "Full"**) | Referrer 5% · Sales 10% · Account 5% · PM 10% · Project 40% · **Coder web 4%** · M&T 26% (tổng 100%). Admin chỉnh được. Phần Coder web trả cho tài khoản do M&T chọn (`settings.dev_user_id`), chưa chọn thì M&T giữ lại. | `rate_policies`, `public/js/revenue-core.js` |
| A5 | Tỷ lệ đặt cọc | 50% giá trị hợp đồng (chỉnh theo từng hợp đồng). | `contracts.deposit_pct` |
| A6 | Thanh toán | MVP: Admin xác nhận chuyển khoản thủ công. Cổng VNPay/MoMo để sang V3. | — |
| A7 | OTP & duyệt khách | MVP chưa có OTP. Customer đăng nhập ngay và được lưu bản nháp Order, nhưng chỉ **gửi** Order sau khi M&T duyệt (đúng Bước 2). Freelancer phải chờ duyệt mới được nhận việc. | `orderFlow.guard('PENDING_INTAKE')` |
| A9 | Thiết kế giao diện | Không dùng glassmorphism mà phẳng và nhẹ; font Be Vietnam Pro; biểu đồ SVG render phía server (không dùng Chart.js qua CDN) | `docs/DESIGN_SYSTEM.md` |
| A8 | Lưu tệp | Ổ đĩa máy chủ, thư mục `storage/private` (không public). Bản production chuyển sang S3 hoặc R2. | `services/files.js` |

---

## 2. Kiến trúc tổng quan

```
                ┌──────────────────────── Trình duyệt ────────────────────────┐
                │  Customer Portal      Freelancer Portal       M&T Admin      │
                │   /customer/*           /fl/*                 /admin/*       │
                └──────────────┬─────────────────────────────────────────────┘
                               │ HTTPS · cookie phiên (httpOnly, SameSite=Lax)
┌──────────────────────────────▼──────────────────────────────────────────────┐
│                       Express app (Node.js, 1 tiến trình)                     │
│  middleware: session → loadUser → requireRole(...) → requireOrderAccess(...)  │
│                                                                               │
│  routes/  auth · customer · freelancer · admin · orders · files               │
│     │                                                                         │
│  services/ (chỉ tầng này được ghi DB — mọi quy tắc nghiệp vụ nằm ở đây)       │
│     orderFlow  (máy trạng thái)    assignment (mời / khóa phân công)          │
│     finance    (thu tiền, đối soát) commission (tính & duyệt hoa hồng)        │
│     files      (quyền tải gốc/demo) audit (nhật ký bất biến)  notify          │
└──────────────┬───────────────────────────────────┬──────────────────────────┘
               │                                   │
      ┌────────▼────────┐                 ┌────────▼─────────┐
      │ SQLite (MVP)     │                 │ storage/private   │
      │ → PostgreSQL     │                 │ CV, CCCD, tệp gốc │
      └─────────────────┘                 └──────────────────┘
```

**Lựa chọn công nghệ**

| Thành phần | Chọn | Lý do | Đánh đổi |
|---|---|---|---|
| Web | Express 4 + EJS (render phía server) | Nhẹ, ít JavaScript ở trình duyệt, dễ phân quyền theo từng trang, đúng tinh thần "ECO" | Tương tác kém mượt hơn SPA. Khi cần app di động thì tách thêm lớp API JSON. |
| CSDL | `node:sqlite` có sẵn trong Node 24 | Không cần cài server CSDL hay build native | Ghi tuần tự, không hợp khi tải lớn. SQL viết theo chuẩn để chuyển sang PostgreSQL. |
| Mật khẩu | `crypto.scrypt` + salt | Có sẵn trong Node, chống brute-force tốt | — |
| Upload | `multer` | Phổ biến, giới hạn được kích thước và định dạng | — |

---

## 3. Máy trạng thái Order

```
DRAFT ──gửi──▶ PENDING_INTAKE ──Sales nhận──▶ CONSULTING ──lập báo giá──▶ QUOTED
                                   │                                    │  │
                                   └──────────── CANCELLED ◀─────────────┘  │ khách từ chối
                                                                         ▼  ▼
                                   khách xác nhận ──▶ CONTRACT_SIGNED   REJECTED (→ CONSULTING để báo giá lại)
                                                          │
                                                          ▼
                                                   AWAITING_DEPOSIT ──Admin xác nhận cọc đủ──▶ DEPOSITED
                                                          │  (hoặc Admin duyệt ngoại lệ, có lý do)  │
                                                                                                   ▼
          ┌───────────────────────────────────────────────────────────── MATCHING (Account mời người)
          │                                                                   │ Account gửi phương án
          │                                                                   ▼
          │                                                     PENDING_MATCH_APPROVAL ──Admin trả lại──▶ MATCHING
          │                                                                   │ Admin duyệt → KHÓA nhân sự + tỷ lệ, tạo PROJn
          ▼                                                                   ▼
   IN_PROGRESS ◀──yêu cầu sửa── IN_REVIEW ◀──Project nộp──  IN_PROGRESS
                                   │ PM/Account đạt
                                   ▼
                              DEMO / PREVIEW ──khách yêu cầu sửa──▶ IN_PROGRESS
                                   │ khách duyệt bản demo
                                   ▼
                          AWAITING_PAYMENT ──thu đủ──▶ ACCEPTANCE (mở tải tệp gốc, ký biên bản nghiệm thu)
                                                          │
                                                          ▼
                                                   RECONCILIATION (Admin đối soát → tính hoa hồng)
                                                          │ đã duyệt hết hoa hồng
                                                          ▼
                                                   COMPLETED ──Admin đóng──▶ CLOSED
```

**Điều kiện chặn (guard), kiểm tra trong `orderFlow.transition()`:**

| Chuyển trạng thái | Điều kiện |
|---|---|
| `AWAITING_DEPOSIT → DEPOSITED` | Tổng đã thực thu ≥ số tiền cọc, **hoặc** Admin bật `deposit_exception` kèm lý do (ghi nhật ký) |
| `DEPOSITED → MATCHING` | Khách hàng đã được xác minh |
| `PENDING_MATCH_APPROVAL → IN_PROGRESS` | Có đủ Account, ít nhất một Project, có người phụ trách chính và người dự phòng (hoặc Admin là dự phòng mặc định). Tổng phần chia trong mỗi vai trò bằng 100%. |
| `AWAITING_PAYMENT → ACCEPTANCE` | Thực thu ròng ≥ giá trị hợp đồng (đã trừ hoàn tiền) |
| `RECONCILIATION → COMPLETED` | Mọi dòng hoa hồng đã ở trạng thái `APPROVED` hoặc `VOID` |
| Bất kỳ → `CANCELLED` | Chỉ trước `IN_PROGRESS`, hoặc Admin hủy kèm lý do (sau đó xử lý hoàn tiền) |

Mỗi lần chuyển trạng thái sẽ ghi `order_status_history` cùng `audit_logs` (ai, lúc nào, từ trạng thái nào sang trạng thái nào, lý do).

**Trạng thái tài khoản:** `PENDING` → `ACTIVE` | `NEEDS_INFO` | `REJECTED` | `SUSPENDED`.

---

## 4. Mô hình dữ liệu

Tiền lưu bằng `INTEGER` (đơn vị VND). Tỷ lệ lưu bằng `INTEGER` theo **basis point** (1% = 100 bp) để tránh lỗi làm tròn số thực.

| Bảng | Khóa / cột chính | Ghi chú |
|---|---|---|
| `users` | id, code (`CUS1`/`FL1`), kind (`customer`/`freelancer`/`admin`), email, phone, password_hash, full_name, status | email và phone là UNIQUE (cho phép NULL) |
| `user_roles` | user_id, role, status, approved_by | Một freelancer có nhiều vai trò. Vai trò chỉ hiệu lực khi `status='ACTIVE'`. |
| `customer_profiles` | user_id, company, tax_code, address, referrer_code | Mã người giới thiệu nhập lúc đăng ký |
| `freelancer_profiles` | user_id, dob, member_code (UNIQUE), skills, experience, portfolio, bank_name, bank_account, cv_file, id_front_file, id_back_file, availability | Thông tin ngân hàng và CCCD chỉ Admin xem |
| `orders` | id, code, customer_id, referrer_id, title, service_type, description, deliverables, budget, deadline, invoice_info, status, needs_pm, deposit_exception | `invoice_info` không bao giờ hiển thị cho freelancer |
| `order_status_history` | order_id, from_status, to_status, actor_id, note | |
| `order_assignments` | order_id, user_id, role, share_bp, is_primary, is_backup, status (`INVITED`/`ACCEPTED`/`DECLINED`/`EXPIRED`/`LOCKED`/`REVOKED`) | UNIQUE(order_id, user_id, role) |
| `quotes` | order_id, version, amount, scope, timeline, status, created_by, confirmed_at | UNIQUE(order_id, version) |
| `contracts` | order_id, quote_id, value, deposit_pct, deposit_amount, terms, signed_at | |
| `projects` | order_id, code (`PROJn`), created_at | Không gian làm việc |
| `tasks` | project_id, title, assignee_id, due_date, status | Mỗi nhiệm vụ chỉ một người làm chính. Đồng thực hiện phải qua `order_assignments`. |
| `deliverables` | order_id, task_id, version, kind (`demo`/`preview`/`final`), file, submitted_by, review_status, reviewed_by | Tệp `final` chỉ tải được sau khi khách thanh toán đủ |
| `acceptances` | order_id, deliverable_id, decision, note, actor_id, created_at | Biên bản nghiệm thu |
| `messages` | order_id, user_id, body, file | Lịch sử trao đổi |
| `payments` | order_id, kind (`deposit`/`installment`/`refund`), amount, tax, deductions, confirmed_by, confirmed_at, reconciled | Hoàn tiền ghi thành **dòng âm riêng**, không sửa dòng cũ |
| `rate_policies` | id, name, rates_json, active_from | Chính sách tỷ lệ |
| `revenue_allocations` | order_id, role, rate_bp, locked_at | **Bản chụp tỷ lệ** của Order lúc khóa phân công. Chính sách mới không ảnh hưởng Order đã khóa. |
| `commissions` | order_id, payment_id, user_id (NULL = M&T), role, base_amount, rate_bp, share_bp, amount, status (`PENDING_APPROVAL`/`APPROVED`/`VOID`/`PAID`), reason, payout_id | **UNIQUE(payment_id, user_id, role)** để chống tính trùng |
| `payouts` | user_id, amount, status, paid_at, ref | Một lần chi gom nhiều dòng hoa hồng |
| `disputes` | order_id, raised_by, kind (`complaint`/`refund`/`change_request`), body, evidence_file, status, resolution | |
| `notifications` | user_id, title, link, read_at | |
| `audit_logs` | actor_id, action, entity, entity_id, before_json, after_json, reason, created_at | Chỉ được INSERT. Không có route nào sửa hay xóa. |
| `sequences` | name (`CUS`/`FL`/`ORD`/`PROJ`), value | Sinh mã tuần tự |

---

## 5. Thuật toán hoa hồng

Hoa hồng chạy khi **Admin bấm "Đối soát"**. Order hoàn tất không làm hệ thống tự chia tiền. Mỗi khoản thanh toán đã xác nhận nhưng chưa đối soát được xử lý như sau:

```
net = amount − tax − deductions            (với refund: net âm → sinh dòng hoa hồng âm điều chỉnh)
for each role in revenue_allocations(order):
    pool = net × rate_bp / 10000
    holders = assignments LOCKED của role đó
    if role = REFERRER and holders rỗng   → 1 dòng cho M&T, reason = "Không có Referrer — Admin giữ lại"
    if role = PM and order.needs_pm = 0   → cộng pool vào role ACCOUNT, reason = "Account kiêm PM"
    else chia pool theo share_bp của từng holder (dòng cuối nhận phần dư làm tròn)
    INSERT commissions(...)  — UNIQUE(payment_id, user_id, role) chặn ghi trùng
mark payment.reconciled = 1
```

- **Một người nhiều vai trò:** mỗi vai trò là một dòng riêng, rồi cộng lại khi chi trả. Ràng buộc UNIQUE ngăn cùng một người nhận hai lần cho cùng vai trò trong cùng đợt thu.
- **Nguồn quy tắc duy nhất:** `computeLines`, `netRevenue` và `simulate` nằm ở `public/js/revenue-core.js` (UMD). Server dùng file này khi đối soát, còn trình duyệt dùng cho bộ tính trên trang `/fl/revenue`, nên con số minh họa luôn khớp với sổ hoa hồng.
- **Coder web:** phần `DEV` được tính trên mọi Order, không đi qua phân công. Người nhận là `settings.dev_user_id`.
- **Trang Doanh thu & dự án** (`/fl/revenue`) tính cho từng dự án đã nhận:
  - *Theo thực thu* = doanh thu thuần đã thu × tỷ lệ hưởng.
  - *Dự kiến cả HĐ* = giá trị HĐ × (thuần ÷ đã thu). Khi chưa có khoản thu nào thì giả định giá đã gồm VAT 10%.

  Tỷ lệ hưởng = Σ(tỷ lệ vai trò × tỷ lệ phân công). Các số này chỉ tính khi xem, **không lưu** vào sổ, nên không nhầm với khoản thực được trả.
- **Điều chỉnh sau khi chốt:** không sửa dòng cũ. Mỗi điều chỉnh tạo một dòng mới kèm lý do và người duyệt, ghi nhật ký.

---

## 6. Ma trận quyền

| Hành động | Customer | Referrer | Sales | Account | PM | Project | Admin |
|---|:-:|:-:|:-:|:-:|:-:|:-:|:-:|
| Đăng / sửa Order nháp | ✔ (của mình) | | | | | | ✔ |
| Tiếp nhận Order, lập báo giá | | | ✔ | ✔ | | | ✔ |
| Xác nhận báo giá / hợp đồng | ✔ | | | | | | |
| Xác nhận thực thu, ngoại lệ cọc | | | | | | | ✔ |
| Mời và ghép nhân sự | | | | ✔ | ✔ (khi có PM) | | ✔ |
| Duyệt và khóa phân công, sửa tỷ lệ | | | | | | | ✔ |
| Nộp sản phẩm | | | | | | ✔ | |
| Kiểm duyệt sản phẩm nội bộ | | | | ✔ (không có PM) | ✔ | | ✔ |
| Nghiệm thu | ✔ | | | | | | |
| Tải tệp gốc | ✔ khi đã trả đủ | | | ✔ | ✔ | ✔ (tệp của mình) | ✔ |
| Xem thông tin hóa đơn, CCCD, STK | | | | | | | ✔ |
| Đối soát, duyệt hoa hồng, chi trả | | | | | | | ✔ |

Freelancer chỉ đọc được Order có `order_assignments.status ∈ {ACCEPTED, LOCKED}` (hoặc `INVITED` ở dạng tóm tắt). Khi bị `REVOKED` hoặc Order `CLOSED`, quyền truy cập workspace bị thu hồi (chỉ xem lịch sử thu nhập).

---

## 7. Rủi ro và những điểm cần xem lại khi hệ thống lớn lên

| Chủ đề | MVP | Khi mở rộng |
|---|---|---|
| CSDL | SQLite một tệp | PostgreSQL + migration (Prisma hoặc Knex), sao lưu định kỳ |
| Tệp | Ổ đĩa cục bộ | S3/R2 + URL có chữ ký và hết hạn, watermark cho bản demo |
| Phiên đăng nhập | Lưu phiên trong SQLite | Redis |
| Thông báo | Hiển thị trong web | Email/Zalo OA, hàng đợi (BullMQ) |
| Hạn "2 giờ hành chính" | Hiển thị hạn chót | Job tự động nhắc và báo quá hạn |
| Ghép tự động (V2) | Account chọn thủ công, hệ thống gợi ý theo kỹ năng | Chấm điểm theo kỹ năng, mức sẵn sàng, đánh giá và khối lượng việc |
| Thanh toán (V3) | Xác nhận thủ công | Webhook VNPay/MoMo, tự đối khớp sao kê |
