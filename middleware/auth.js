const jwt = require('jsonwebtoken');

module.exports = function(req, res, next) {
    // Lấy token từ header
    const token = req.header('Authorization');

    // Kiểm tra nếu không có token
    if (!token) {
        return res.status(401).json({ message: 'Không có token, truy cập bị từ chối.' });
    }

    try {
        // Token thường có dạng "Bearer [token]", ta cần tách nó ra
        const tokenOnly = token.split(' ')[1];
        const decoded = jwt.verify(tokenOnly, process.env.JWT_SECRET);

        // Gán thông tin user đã giải mã vào request để các API sau có thể dùng
        req.user = decoded.user;
        next(); // Chuyển sang bước tiếp theo
    } catch (err) {
        res.status(401).json({ message: 'Token không hợp lệ.' });
    }
};