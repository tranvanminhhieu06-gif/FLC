# FLC Design System v0.1

Mã nguồn duy nhất của hệ thống thiết kế: [`public/css/flc.css`](../public/css/flc.css). Mọi màu, khoảng cách và cỡ chữ trong view đều lấy qua token, **không viết mã hex trực tiếp trong template**.

## Định hướng

- **ECO = nhẹ:** giao diện phẳng, không dùng blur hay glassmorphism, không ảnh nền nặng. Trang được render phía server, mỗi trang chỉ có khoảng 20 dòng JavaScript (bật/tắt menu trên điện thoại).
- **Cảm giác:** tin cậy, rõ ràng, giống một công cụ tài chính hơn là một trang quảng cáo. Màu nhấn chỉ dùng cho hành động quan trọng.
- Nguồn tham khảo là kết quả tra cứu của *ui-ux-pro-max* (bảng màu "Sustainable / Climate Tech" và các quy tắc B2B SaaS), sau đó chỉnh lại: bỏ glassmorphism cho đúng tinh thần ECO, và đổi font sang **Be Vietnam Pro** vì font này được thiết kế cho tiếng Việt và hiển thị dấu chuẩn.

## Token

| Nhóm | Token | Giá trị | Dùng cho |
|---|---|---|---|
| Brand | `--c-brand-700` | `#047857` | Nút chính, link, mục đang chọn (tương phản 5.5:1 trên nền trắng) |
| | `--c-brand-900` | `#064e3b` | Nền sidebar |
| Accent | `--c-accent-500` | `#f59e0b` | CTA phụ (Đăng Order), số đếm trên menu. Chữ đặt trên nền này luôn là màu tối. |
| Nền | `--c-bg` / `--c-surface` | `#f7faf9` / `#fff` | Nền trang / thẻ |
| Chữ | `--c-text` / `--c-text-muted` | `#0f1f1a` / `#475569` | Đều đạt tương phản AA trên `--c-surface` |
| Trạng thái | `info` `success` `warn` `danger` `violet` `neutral` | cặp `-bg` / `-fg` | Badge, cảnh báo |
| Chữ | `--fs-xs … --fs-3xl` | 12 → 40px | Chữ nội dung 16px, giãn dòng 1.55 |
| Khoảng cách | `--sp-1 … --sp-16` | lưới 4px | |
| Bo góc | `--r-sm/md/lg/pill` | 6 / 10 / 14 / 999 | |
| Chuyển động | `--dur-fast`, `--dur` | 120 / 200ms | Tự về 0 khi người dùng bật `prefers-reduced-motion` |

## Màu trạng thái Order

Ánh xạ trạng thái sang màu nằm ở `src/lib/labels.js`, giữ một nguồn duy nhất cho cả badge lẫn dashboard. Badge luôn có chữ đi kèm, không bao giờ chỉ dùng màu để truyền đạt trạng thái.

| Màu | Nhóm trạng thái |
|---|---|
| neutral | Bản nháp, Đã đóng |
| info | Chờ tiếp nhận, Tư vấn, Báo giá |
| warn | Chờ cọc, Chờ duyệt ghép, Chờ thanh toán, Đang kiểm duyệt |
| violet | Đang ghép, Demo, Preview, Đối soát |
| brand | Đã cọc, Ký hợp đồng, Đang triển khai, Nghiệm thu |
| success | Hoàn tất |
| danger | Từ chối, Hủy |

## Component

| Component | Class | Biến thể / trạng thái | Ghi chú truy cập |
|---|---|---|---|
| Button | `.btn` | `-primary` `-accent` `-secondary` `-ghost` `-danger`, cỡ `-sm`, `-block`; trạng thái hover, focus-visible, disabled | Cao tối thiểu 44px (36px cho `-sm` trong bảng) |
| Field | `.field` > `label` + `.input`/`.select`/`.textarea` + `.hint`/`.error` | `aria-invalid` | Nhãn luôn hiển thị, không dùng placeholder thay nhãn. Lỗi hiện ngay dưới ô. |
| Check chip | `.check` | Đổi nền khi được chọn (`:has(:checked)`) | Dùng để chọn vai trò hoặc kỹ năng |
| Card | `.card`, `.card-head`, `.card.flush` | | |
| Badge | `.badge.{info…}` | | Chấm màu kèm chữ |
| Table | `.table-wrap > .table`, `.num` | | Cuộn ngang khi màn hình hẹp. Cột số căn phải, dùng chữ số đều độ rộng. |
| Alert | `.alert.{info…}` | | Có `role="status"` (hoặc `alert` khi là lỗi) |
| Stat tile | `.stat` | | Dùng cho dashboard |
| Stepper | `.stepper li.done/.current` | | Hiển thị 7 bước của Order |
| Timeline | `.timeline` | | Lịch sử trạng thái |
| Tabs | `.tabs a[aria-current]` | | Dạng link, có thể deep-link |
| App shell | `.app > .sidebar + .main > .topbar + .content` | `.nav-open` trên điện thoại | Sidebar trượt ra trên màn hình hẹp |

## Nên / Không nên

| ✅ Nên | ❌ Không nên |
|---|---|
| Một nút `btn-primary` cho mỗi khu vực hành động | Đặt nhiều nút primary ngang nhau |
| Dùng `btn-accent` cho đúng một CTA nổi bật trên trang (Đăng Order) | Dùng accent làm màu chữ |
| Hiển thị tiền bằng `fmt.vnd()`, căn phải trong bảng | Tự format thủ công từng chỗ |
| Icon SVG đặt trong `partials/icons.ejs` | Dùng emoji làm icon |
