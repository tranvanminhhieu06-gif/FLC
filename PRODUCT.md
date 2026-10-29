# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

- **Freelancer FLC (ưu tiên số một).** Thành viên mạng lưới FLC giữ một hoặc nhiều vai trò: Referrer, Sales, Account, PM, Project. Mỗi ngày họ vào để xem dự án khách vừa đăng, nhận lời mời, làm việc được giao, nộp sản phẩm, xác nhận hoặc khiếu nại hoa hồng, theo dõi doanh thu và thứ hạng. Phần lớn là người làm nghề số (coder, designer, marketer), mở app nhiều lần trong ngày, cả trên laptop lẫn điện thoại.
- **Khách hàng.** Doanh nghiệp hoặc cá nhân đặt dịch vụ: gửi yêu cầu, nhận báo giá, ký hợp đồng, đặt cọc, xem demo, nghiệm thu, thanh toán.
- **M&T Admin.** Đội M&T Group kiểm duyệt: duyệt tài khoản, điều phối và duyệt ghép nhân sự, xử lý khiếu nại, đối soát thanh toán, duyệt và chi hoa hồng, đặt tỷ lệ doanh thu.

## Product Purpose

FLC là nền tảng Order dịch vụ đa vai trò do M&T Group vận hành. Nó kết nối khách hàng với mạng lưới freelancer FLC. Order không theo kiểu ai nhận trước làm trước: mỗi Order đi qua quy trình 7 bước có điều kiện chuyển bước, được phân công theo vai trò, có sổ doanh thu và sổ hoa hồng riêng. Thành công nghĩa là Order chạy đúng quy trình, tiền và hoa hồng minh bạch với mọi bên, và freelancer muốn quay lại nhận việc.

## Positioning

Đây không phải chợ việc tự do. Mọi Order có M&T đứng giữa kiểm duyệt; trạng thái được kiểm tra theo quyền từng vai trò; lịch sử thay đổi không xóa được; hoa hồng chỉ được chi khi cả hai bên (freelancer và M&T) đã đồng ý.

## Operating Context

- Quy trình 7 bước, 20 trạng thái Order (STT1–20) và các trạng thái hoa hồng (STT21–24). Bảng trạng thái công khai có tại `/statuses`.
- Bốn trường trạng thái tách riêng: Order, công việc, thanh toán, hoa hồng.
- Giao diện ba cổng: Customer (`/customer`), Freelancer (`/fl`), M&T Admin (`/admin`). Thêm trang giới thiệu, đăng nhập và đăng ký công khai.
- Tiền tệ là VND; thanh toán theo hợp đồng, có đặt cọc và đối soát.

## Capabilities and Constraints

- Stack: Node.js ≥ 22.13, Express, EJS render phía server, CSS thuần (`public/css/flc.css`), JS phía trình duyệt tối thiểu (`public/js/app.js`). Không dùng framework front-end, không có bước build.
- CSP chặt: `img-src 'self' data:`, không tải script ngoài. Font và tài nguyên phải tự phục vụ hoặc qua nguồn CSP cho phép.
- Biểu đồ được render bằng SVG phía server trong EJS.
- Toàn bộ giao diện bằng tiếng Việt; mã trạng thái tiếng Anh nằm trong CSDL, nhãn tiếng Việt hiện trên màn hình.

## Brand Commitments

- Tên: **FLC**, vận hành bởi **M&T Group**.
- Giữ giao diện hiện tại (người dùng quyết định ngày 2026-10-29, sau khi xem các hướng làm lại): nền emerald, nút nhấn amber, font Be Vietnam Pro, phong cách phẳng nhẹ trong `public/css/flc.css` và `docs/DESIGN_SYSTEM.md`. Thay đổi giao diện sau này chỉ trau chuốt trong hệ thống đó, không thay thế.

## Evidence on Hand

- Dữ liệu demo do `scripts/seed.js` tạo. Hiện chưa có khách hàng thật, lời chứng thực, số liệu hay logo đối tác thật; không được bịa ra.

## Product Principles

1. Minh bạch trước tiên: trạng thái, tiền và hoa hồng luôn đọc được, kèm lý do và lịch sử.
2. Mỗi vai trò chỉ thấy và làm đúng việc của mình; hành động không được phép thì không hiện.
3. Freelancer dùng hằng ngày, nên các việc lặp lại phải nhanh và dễ quét mắt.
4. M&T đứng giữa là điểm tin cậy; giao diện phải cho thấy sự kiểm duyệt đó, không che đi.

## Accessibility & Inclusion

- Tiếng Việt có dấu đầy đủ: font phải hỗ trợ trọn bộ ký tự tiếng Việt.
- Trạng thái không bao giờ chỉ dùng màu; luôn có chữ đi kèm.
- Dùng tốt trên điện thoại (freelancer, khách hàng) và có chế độ giảm chuyển động.
