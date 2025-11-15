// Import các thư viện cần thiết
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const authMiddleware = require('./middleware/auth');
const Groq = require('groq-sdk');

const app = express();
const port = process.env.PORT || 5001;

// ... middleware setup ...
app.use(cors());
app.use(express.json());

// ... database pool setup ...
const pool = new Pool({
    user: process.env.DB_USER,
    host: process.env.DB_HOST,
    database: process.env.DB_DATABASE,
    password: process.env.DB_PASSWORD,
    port: process.env.DB_PORT,
});

// === KHAI BÁO GROQ VÀ CÁC HÀM TRUY VẤN CSDL (DATABASE FUNCTIONS) ===

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

// (ĐÃ NÂNG CẤP) Hàm getQueryDate mạnh mẽ hơn
function getQueryDate(dateString) {
    
    // Helper to get "today" in Vietnam (UTC+7)
    // Trả về chuỗi YYYY-MM-DD
    const getTodayInVietnam = () => {
        const now = new Date();
        // Chuyển 'now' sang múi giờ VN (UTC+7)
        const vnTime = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Ho_Chi_Minh' }));
        vnTime.setHours(0, 0, 0, 0);

        const year = vnTime.getFullYear();
        const month = String(vnTime.getMonth() + 1).padStart(2, '0'); // getMonth() là 0-11
        const day = String(vnTime.getDate()).padStart(2, '0');
        
        return `${year}-${month}-${day}`;
    };
    
    // Helper to get "tomorrow" in Vietnam
    const getTomorrowInVietnam = () => {
        const now = new Date();
        const vnTime = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Ho_Chi_Minh' }));
        vnTime.setDate(vnTime.getDate() + 1); // Lấy ngày mai
        vnTime.setHours(0, 0, 0, 0);

        const year = vnTime.getFullYear();
        const month = String(vnTime.getMonth() + 1).padStart(2, '0');
        const day = String(vnTime.getDate()).padStart(2, '0');
        
        return `${year}-${month}-${day}`;
    };

    const todayVNDateString = getTodayInVietnam();
    // Tạo ngày 'today' (đã set 0 giờ) ở múi giờ VN
    const todayVN = new Date(new Date(todayVNDateString).toLocaleString('en-US', { timeZone: 'Asia/Ho_Chi_Minh' }));
    todayVN.setHours(0, 0, 0, 0);


    if (!dateString) {
        // Mặc định là hôm nay (VN) nếu không có chuỗi ngày
        return todayVNDateString;
    }

    const lowerCase = dateString.toLowerCase().trim();
    
    if (lowerCase.includes('hôm nay') || lowerCase.includes('today')) {
        return todayVNDateString;
    }
    if (lowerCase.includes('ngày mai') || lowerCase.includes('tomorrow')) {
        return getTomorrowInVietnam();
    }

    // === SỬA LỖI REGEX ===
    // Thử match YYYY-MM-DD trước (ví dụ: "ngày 2025-11-15")
    let match = lowerCase.match(/(\d{4})[\-\/\.](\d{1,2})[\-\/\.](\d{1,2})/);
    if (match) {
        const year = parseInt(match[1], 10);
        const month = parseInt(match[2], 10) - 1; // JS month is 0-indexed
        const day = parseInt(match[3], 10);
        // Tạo ngày bằng cách sử dụng các thành phần (an toàn với múi giờ)
        const queryDate = new Date(year, month, day); 
        queryDate.setHours(0, 0, 0, 0);
        return queryDate.toISOString().split('T')[0];
    }

    // Thử match DD/MM/YYYY hoặc DD-MM-YYYY (và các biến thể)
    // Regex này tìm DD và MM, và (tùy chọn) YYYY
    // (?:\D*?) non-greedy-ly matches optional non-digits at the start
    match = lowerCase.match(/(?:\D*?)(\d{1,2})[\/\-\.](\d{1,2})(?:[\/\-\.](\d{4}))?\D*/);
    if (match) {
        const day = parseInt(match[1], 10);
        const month = parseInt(match[2], 10) - 1; // JS month is 0-indexed
        const year = match[3] ? parseInt(match[3], 10) : todayVN.getFullYear(); // Default to current VN year
        
        const queryDate = new Date(year, month, day); 
        queryDate.setHours(0, 0, 0, 0);

        // Xử lý trường hợp người dùng nhập "15-11" nhưng năm nay đã qua tháng 11
        if (queryDate < todayVN) {
             queryDate.setFullYear(year + 1);
        }

        return queryDate.toISOString().split('T')[0];
    }
    // === KẾT THÚC SỬA LỖI REGEX ===

    // Mặc định là hôm nay nếu không parse được
    console.warn(`[getQueryDate] Không thể parse chuỗi ngày: "${dateString}". Trả về ngày hôm nay (VN).`);
    return todayVNDateString;
}


/**
 * CÔNG CỤ TRUY VẤN 1: Lấy suất chiếu cho một phim cụ thể
 * (Phiên bản nâng cấp: Chấp nhận city_name hoặc cinema_name)
 */
async function get_showtimes_for_movie(args) {
    // args là một object: { movie_title, date, city_name?, cinema_name? }
    const { movie_title, city_name, cinema_name, date } = args;
    console.log(`[Agent] Đang chạy tool: get_showtimes_for_movie`, args);
    
    // Yêu cầu tối thiểu là phải có phim và ngày
    if (!movie_title || !date) {
        return JSON.stringify({ error: "Thiếu thông tin phim hoặc ngày chiếu." });
    }
    // Yêu cầu phải có 1 trong 2: thành phố hoặc rạp
    if (!city_name && !cinema_name) {
         return JSON.stringify({ message: `Bạn muốn xem phim '${movie_title}' ở thành phố hay rạp nào?` });
    }

    const queryDate = getQueryDate(date);

    try {
        let queryParams = [`%${movie_title}%`, queryDate];
        let query = `
            SELECT 
                s.showtime_id,
                s.start_time, 
                s.ticket_price,
                c.name as cinema_name,
                c.city,
                m.movie_id,
                m.title,
                m.features
            FROM showtimes s
            JOIN movies m ON s.movie_id = m.movie_id
            JOIN cinemas c ON s.cinema_id = c.cinema_id
            WHERE 
                m.title ILIKE $1 
                AND s.start_time::date = $2
                AND s.start_time > NOW()
        `;

        // Xây dựng query động
        if (city_name) {
            queryParams.push(`%${city_name}%`);
            query += ` AND c.city ILIKE $${queryParams.length}`;
        }
        
        if (cinema_name) {
            queryParams.push(`%${cinema_name}%`);
            query += ` AND c.name ILIKE $${queryParams.length}`;
        }

        query += ` ORDER BY c.name, s.start_time;`;
        
        console.log("[Agent] SQL Query:", query);
        console.log("[Agent] SQL Params:", queryParams);

        const result = await pool.query(query, queryParams);
        
        if (result.rows.length === 0) {
            let errorMessage = `Rất tiếc, tôi không tìm thấy suất chiếu nào cho phim '${movie_title}'`;
            if (cinema_name) errorMessage += ` tại '${cinema_name}'`;
            else if (city_name) errorMessage += ` tại '${city_name}'`;
            errorMessage += ` vào ngày ${queryDate}.`;
            return JSON.stringify({ message: errorMessage });
        }
        
        // Trả về dữ liệu đầy đủ
        return JSON.stringify(result.rows);

    } catch (e) {
        console.error("Lỗi khi truy vấn get_showtimes_for_movie:", e);
        return JSON.stringify({ error: "Đã xảy ra lỗi khi truy vấn cơ sở dữ liệu." });
    }
}

/**
 * CÔNG CỤ TRUY VẤN 2: Lấy danh sách phim đang chiếu tại một rạp cụ thể
 */
async function get_movies_at_cinema(cinema_name, date) {
    console.log(`[Agent] Đang chạy tool: get_movies_at_cinema`, { cinema_name, date });
    const queryDate = getQueryDate(date);

    try {
        const query = `
            SELECT 
                m.title, 
                m.genre,
                COUNT(s.showtime_id) as showtime_count
            FROM showtimes s
            JOIN movies m ON s.movie_id = m.movie_id
            JOIN cinemas c ON s.cinema_id = c.cinema_id
            WHERE 
                c.name ILIKE $1 
                AND s.start_time::date = $2
                AND s.start_time > NOW()
            GROUP BY m.title, m.genre
            ORDER BY m.title;
        `;
        const result = await pool.query(query, [`%${cinema_name}%`, queryDate]);

        if (result.rows.length === 0) {
            return JSON.stringify({ message: `Không tìm thấy phim nào đang chiếu tại '${cinema_name}' vào ngày ${queryDate}.` });
        }
        return JSON.stringify(result.rows);
    } catch (e) {
        console.error("Lỗi khi truy vấn get_movies_at_cinema:", e);
        return JSON.stringify({ error: "Đã xảy ra lỗi khi truy vấn cơ sở dữ liệu." });
    }
}

/**
 * CÔNG CỤ TRUY VẤN 3: Lấy thông tin chi tiết (cốt truyện, diễn viên) của một phim
 */
async function get_movie_details(movie_title) {
    console.log(`[Agent] Đang chạy tool: get_movie_details`, { movie_title });
    try {
        const query = `
            SELECT 
                title, description, genre, rating, director, cast_members, duration_minutes 
            FROM movies 
            WHERE title ILIKE $1 
            LIMIT 1;
        `;
        const result = await pool.query(query, [`%${movie_title}%`]);
        
        if (result.rows.length === 0) {
            return JSON.stringify({ message: `Không tìm thấy thông tin cho phim '${movie_title}'.` });
        }
        return JSON.stringify(result.rows[0]);
    } catch (e) {
        console.error("Lỗi khi truy vấn get_movie_details:", e);
        return JSON.stringify({ error: "Đã xảy ra lỗi khi truy vấn cơ sở dữ liệu." });
    }
}

/**
 * CÔNG CỤ TRUY VẤN 4: Đề xuất phim dựa trên lịch sử xem phim của user
 * (Sử dụng userId từ authMiddleware, không cần LLM cung cấp)
 */
async function get_movie_recommendations_based_on_history(userId) {
    console.log(`[Agent] Đang chạy tool: get_movie_recommendations_based_on_history cho UserID: ${userId}`);
    
    if (!userId) {
        return JSON.stringify({ error: "Không xác định được người dùng." });
    }

    try {
        // 1. Lấy 5 thể loại phim user xem nhiều nhất từ lịch sử booking
        const genreHistoryQuery = `
            SELECT 
                m.genre, 
                COUNT(b.booking_id) AS watch_count
            FROM Bookings b
            JOIN Showtimes s ON b.showtime_id = s.showtime_id
            JOIN Movies m ON s.movie_id = m.movie_id
            WHERE b.user_id = $1 
              AND s.start_time < NOW() -- Chỉ tính phim đã xem
            GROUP BY m.genre
            ORDER BY watch_count DESC
            LIMIT 5;
        `;
        const genreResult = await pool.query(genreHistoryQuery, [userId]);

        if (genreResult.rows.length === 0) {
            return JSON.stringify({ message: "Bạn chưa có lịch sử xem phim. Hãy thử xem một phim nào đó!" });
        }

        const favoriteGenres = genreResult.rows.map(r => r.genre);
        const topGenre = favoriteGenres[0]; // Lấy thể loại yêu thích nhất

        // 2. Lấy danh sách phim user đã xem
        const seenMoviesQuery = `
            SELECT DISTINCT s.movie_id 
            FROM Bookings b
            JOIN Showtimes s ON b.showtime_id = s.showtime_id
            WHERE b.user_id = $1;
        `;
        const seenMoviesResult = await pool.query(seenMoviesQuery, [userId]);
        const seenMovieIds = seenMoviesResult.rows.map(r => r.movie_id);

        // 3. Tìm phim mới (đang chiếu, cùng thể loại, user chưa xem)
        const recommendationsQuery = `
            SELECT 
                movie_id, 
                title, 
                genre,
                poster_url,
                description
            FROM Movies
            WHERE genre = $1                   -- Cùng thể loại yêu thích nhất
              AND release_date <= CURRENT_DATE -- Đang chiếu
              AND movie_id != ALL($2::int[])   -- Chưa xem
            ORDER BY rating DESC
            LIMIT 3;                           -- Đề xuất 3 phim
        `;
        
        const recommendationsResult = await pool.query(recommendationsQuery, [topGenre, seenMovieIds]);

        if (recommendationsResult.rows.length === 0) {
            return JSON.stringify({ message: `Tôi thấy bạn thích phim thể loại '${topGenre}', nhưng hiện tại không có phim mới nào cùng thể loại mà bạn chưa xem.` });
        }

        // Trả về danh sách đề xuất
        return JSON.stringify({
            top_genre: topGenre,
            recommendations: recommendationsResult.rows
        });

    } catch (e) {
        console.error("Lỗi khi truy vấn get_movie_recommendations_based_on_history:", e);
        return JSON.stringify({ error: "Đã xảy ra lỗi khi lấy đề xuất phim." });
    }
}


// "Menu" các công cụ mà LLM có thể gọi
const tools = [
    {
        type: "function",
        function: {
            name: "get_showtimes_for_movie",
            description: "Lấy suất chiếu cho một BỘ PHIM, lọc theo NGÀY và (THÀNH PHỐ hoặc RẠP PHIM CỤ THỂ).",
            parameters: {
                type: "object",
                properties: {
                    movie_title: { type: "string", description: "Tên bộ phim, ví dụ: 'Mai'" },
                    date: { type: "string", description: "Ngày cần tra cứu, ví dụ: 'hôm nay', 'ngày mai', '15-11', '2025-11-15'" },
                    city_name: { type: "string", description: "Tên thành phố (nếu người dùng cung cấp). Ví dụ: 'Đà Nẵng'" },
                    cinema_name: { type: "string", description: "Tên rạp phim cụ thể (nếu người dùng cung cấp). Ví dụ: 'CGV Lotte Mart Đà Nẵng'" }
                },
                required: ["movie_title", "date"] 
            }
        }
    },
    {
        type: "function",
        function: {
            name: "get_movies_at_cinema",
            description: "Lấy danh sách các BỘ PHIM đang được chiếu tại một RẠP PHIM cụ thể vào một NGÀY cụ thể.",
            parameters: {
                type: "object",
                properties: {
                    cinema_name: { type: "string", description: "Tên rạp phim, ví dụ: 'CGV Giga Mall', 'CGV Vincom Center'" },
                    date: { type: "string", description: "Ngày cần tra cứu, ví dụ: 'hôm nay', 'ngày mai'" }
                },
                required: ["cinema_name", "date"]
            }
        }
    },
    {
        type: "function",
        function: {
            name: "get_movie_details",
            description: "Lấy thông tin chi tiết (cốt truyện, diễn viên, đạo diễn, thể loại) của một BỘ PHIM cụ thể.",
            parameters: {
                type: "object",
                properties: {
                    movie_title: { type: "string", description: "Tên bộ phim, ví dụ: 'Mai'" }
                },
                required: ["movie_title"]
            }
        }
    },
    {
        type: "function",
        function: {
            name: "get_movie_recommendations_based_on_history",
            description: "Đề xuất 3 phim mới (mà user chưa xem) dựa trên thể loại yêu thích từ lịch sử xem phim của người dùng. Chỉ gọi khi user hỏi chung chung như 'đề xuất phim', 'phim nào hay', 'nên xem gì'. Không cần tham số đầu vào từ user.",
            parameters: {
                type: "object",
                properties: {},
                required: []
            }
        }
    }
];

// === PROMPT MỚI ===

// Prompt 1: Dành cho tra cứu và chat thông thường (Giai đoạn 1 & 2)
// SỬA: Thêm quy tắc GHI NHỚ BỐI CẢNH
const getSystemPrompt_Normal = (user, availableMoviesList, availableCitiesList, availableCinemasList) => `
Bạn là "CGV-Bot", một trợ lý AI chuyên nghiệp và thân thiện của rạp phim CGV.
Bạn đang nói chuyện với ${user.username}.

**DỮ LIỆU HIỆN CÓ (RAG) - Chỉ dùng để đối chiếu tên:**
* Các phim đang chiếu: ${availableMoviesList}
* Các thành phố: ${availableCitiesList}
* Các rạp: ${availableCinemasList}

**QUY TẮC CỦA BẠN:**

**1. ƯU TIÊN TRA CỨU & ĐỀ XUẤT:**
* Khi người dùng hỏi thông tin (suất chiếu, chi tiết phim) hoặc hỏi đề xuất phim chung chung.
* Luôn cố gắng **tự động gọi tool** \`get_showtimes_for_movie\`, \`get_movies_at_cinema\`, \`get_movie_details\`, hoặc \`get_movie_recommendations_based_on_history\` bằng cách sử dụng schema tool đã cung cấp.
* **GHI NHỚ BỐI CẢNH (RẤT QUAN TRỌNG):** Khi người dùng cung cấp thông tin mới (ví dụ: "ngày 15-11"), bạn PHẢI NHỚ LẠI bối cảnh cũ (ví dụ: phim 'Wicked', rạp 'CGV Vincom Đà Nẵng') từ các tin nhắn trước đó và GỘP TẤT CẢ thông tin vào lệnh gọi tool.
* **VÍ DỤ GHI NHỚ:**
    * User: "cgv vincom đà nẵng"
    * Bot: (Hỏi thiếu phim)
    * User: "phim wicked"
    * Bot: (Gọi tool với \`cinema_name: 'cgv vincom đà nẵng'\`, \`movie_title: 'wicked'\`, \`date: 'hôm nay'\`)
    * Bot: (Trả về kết quả ngày hôm nay...)
    * User: "ngày 15-11"
    * Bot: (PHẢI gọi tool với \`cinema_name: 'cgv vincom đà nẵng'\`, \`movie_title: 'wicked'\`, \`date: 'ngày 15-11'\`)
* **HỎI NẾU THIẾU:** Nếu thiếu thông tin bắt buộc để gọi tool (ví dụ: thiếu phim, hoặc thiếu cả rạp/thành phố), hãy hỏi người dùng một cách thân thiện.
* **TRÌNH BÀY KẾT QUẢ:** Sau khi tool chạy (và bạn nhận được \`role: "tool"\`), hãy tóm tắt kết quả JSON đó thành câu trả lời thân thiện.
* **QUAN TRỌNG:** Khi liệt kê suất chiếu, HÃY BAO GỒM các định dạng phim (features) nếu có (ví dụ: "3D", "IMAX").
* **VÍ DỤ:** "Tôi tìm thấy 2 suất 'Wicked' tại CGV Vincom Đà Nẵng hôm nay: Suất 1: 10:00 (IMAX, 3D) - 100.000 đồng. Suất 2: 13:45 (IMAX, 3D) - 80.000 đồng. Bạn muốn chọn suất nào?"
* **XỬ LÝ ĐẶT VÉ (RẤT QUAN TRỌNG):** Nếu người dùng nói "tôi muốn đặt vé" (như ảnh 00.10.34.png), BẠN KHÔNG ĐƯỢC HỎI TÊN HAY SỐ ĐIỆN THOẠI. Thay vào đó, bạn PHẢI HỎI LẠI: "Bạn muốn xem phim gì, ở rạp nào và vào ngày nào?".

**2. CHAT BÌNH THƯỜNG:**
* Nếu không phải trường hợp trên, hãy trả lời như một trợ lý thân thiện.

**3. QUY TẮC VÀNG (CHỐNG ẢO GIÁC):**
* NẾU KẾT QUẢ TỪ TOOL LÀ RỖNG (ví dụ: \`[]\`) hoặc là một tin nhắn lỗi (ví dụ: \`{"message": "Không tìm thấy..."}\`), BẠN PHẢI BÁO LẠI CHÍNH XÁC LỖI ĐÓ CHO NGƯỜI DÙNG (ví dụ: "Rất tiếc, tôi không tìm thấy...").
* **TUYỆT ĐỐI KHÔNG** được bịa đặt thông tin suất chiếu, rạp phim, hoặc giá vé nếu tool trả về kết quả rỗng.
`;

// Prompt 2: Dành riêng cho việc chốt vé (Giai đoạn 3)
// SỬA: Thay đổi nhiệm vụ: Chỉ trích xuất SỐ THỨ TỰ hoặc GIỜ
const getSystemPrompt_ChotVe = () => `
Bạn là một bot trích xuất thông tin. Lịch sử chat chứa:
1. Một tin nhắn \`role: "assistant"\` liệt kê các suất chiếu (ví dụ: "Suất 1: 10:00", "Suất 2: 13:45").
2. Một tin nhắn \`role: "user"\` (cuối cùng) chỉ ra lựa chọn của họ (ví dụ: "suất 2", "cái 13:45").

**HÀNH ĐỘNG CỦA BẠN:**
Xác định xem người dùng đã chọn suất nào. Trả lời CHỈ bằng JSON.
- Nếu user chọn bằng SỐ THỨ TỰ (ví dụ: "suất 2", "cái thứ hai"), trả về: \`{"choice_index": 2}\` (số là 1-based index).
- Nếu user chọn bằng GIỜ (ví dụ: "suất 13:45", "1:45 chiều"), trả về: \`{"choice_time": "13:45"}\` (dạng HH:mm).
- Nếu user TỪ CHỐI (ví dụ: "không", "thôi"), trả về: \`{"choice_index": -1}\`.

**KHÔNG** được thêm bất kỳ lời nói nào. Chỉ trả về JSON.

**VÍ DỤ 1 (Chọn theo số):**
* User: "suất 2"
* Bot: \`{"choice_index": 2}\`

**VÍ DỤ 2 (Chọn theo giờ):**
* User: "cho tôi suất 10:00"
* Bot: \`{"choice_time": "10:00"}\`

**VÍ DỤ 3 (Từ chối):**
* User: "thôi không đặt nữa"
* Bot: \`{"choice_index": -1}\`
`;


// === API CHATBOT RAG NÂNG CAO (AGENTIC RAG) ===
app.post('/api/chat', authMiddleware, async (req, res) => {
    const { message, history } = req.body;
    const userId = req.user.id;

    if (!message) {
        return res.status(400).json({ message: 'Tin nhắn không được để trống.' });
    }

    try {
        // --- BƯỚC 1: Lấy thông tin người dùng, lịch sử chat VÀ DANH SÁCH PHIM/THÀNH PHỐ ---
        const userQuery = 'SELECT username, email FROM Users WHERE user_id = $1';
        const userResult = await pool.query(userQuery, [userId]);
        const user = userResult.rows[0] || { username: 'Khách', email: '' };

        const moviesQuery = "SELECT title FROM Movies WHERE release_date <= CURRENT_DATE ORDER BY title";
        const moviesResult = await pool.query(moviesQuery);
        const availableMoviesList = moviesResult.rows.map(m => m.title).join(', ');
        
        const citiesQuery = "SELECT DISTINCT city FROM Cinemas ORDER BY city";
        const citiesResult = await pool.query(citiesQuery);
        const availableCitiesList = citiesResult.rows.map(c => c.city).join(', ');
        
        const cinemasQuery = "SELECT name, city FROM Cinemas ORDER BY city, name";
        const cinemasResult = await pool.query(cinemasQuery);
        // SỬA LỖI: Cung cấp danh sách "sạch"
        const availableCinemasList = cinemasResult.rows.map(c => c.name).join('; ');


        // Chuyển đổi lịch sử chat (nếu có) sang định dạng của Groq
        const conversationHistory = history ? history.map(msg => ({
            role: msg.sender === 'user' ? 'user' : 'assistant',
            content: msg.text 
        })) : [];

        // === SỬA LỖI LOGIC: Làm cho việc kiểm tra Giai Đoạn 3 linh hoạt hơn ===
        let isChotDonGiaiDoan3 = false;
        if (conversationHistory.length > 1) { 
            const lastMessage_User = conversationHistory[conversationHistory.length - 1];
            const secondToLastMessage_Bot = conversationHistory[conversationHistory.length - 2];

            if (lastMessage_User.role === 'user' && secondToLastMessage_Bot.role === 'assistant') {
                const botQuestion = secondToLastMessage_Bot.content.toLowerCase();
                // SỬA LỖI: Chỉ kích hoạt Giai đoạn 3 nếu câu hỏi LÀ VỀ CHỌN SUẤT
                // Xóa "đặt vé" và "chọn không" vì nó quá chung chung và trùng với lời chào
                if (botQuestion.includes("suất nào") || botQuestion.includes("chọn suất này không")) {
                    isChotDonGiaiDoan3 = true;
                }
            }
        }
        // === KẾT THÚC SỬA LỖI LOGIC ===
        
        // === THAY ĐỔI LOGIC CHỌN PROMPT ===
        let systemPrompt;
        let toolChoice;
        
        if (isChotDonGiaiDoan3) {
            systemPrompt = getSystemPrompt_ChotVe();
            toolChoice = "none";
            console.log("[Agent] PHÁT HIỆN GIAI ĐOẠN 3 (CHỐT ĐƠN). Dùng prompt chuyên dụng + JSON mode.");
        } else {
            systemPrompt = getSystemPrompt_Normal(user, availableMoviesList, availableCitiesList, availableCinemasList);
            toolChoice = "auto";
            console.log("[Agent] Giai Đoạn 1/2 (Tra cứu/Chat). Dùng prompt tiêu chuẩn.");
        }
        // === KẾT THÚC THAY ĐỔI ===
        
        // Chuẩn bị message cho LLM Call 1
        const messagesForLLM = [
            { role: "system", content: systemPrompt },
            ...conversationHistory
        ];

        // === BƯỚC 2: LLM CALL 1 (QUYẾT ĐỊNH) ===
        console.log("[Agent] Bắt đầu LLM Call 1 (Quyết định)...");
        
        // SỬA: Thêm `response_format` cho Giai Đoạn 3
        const completionConfig = {
            model: "llama-3.1-8b-instant", // Sửa: Dùng 3.1 70b cho ổn định
            messages: messagesForLLM,
            tools: tools,
            tool_choice: toolChoice
        };

        if (isChotDonGiaiDoan3) {
            completionConfig.response_format = { type: "json_object" };
            delete completionConfig.tools; // Không cần tool khi ở JSON mode
            delete completionConfig.tool_choice;
        }

        const response = await groq.chat.completions.create(completionConfig);

        const responseMessage = response.choices[0].message;

        // === BƯỚC 3: KIỂM TRA VÀ THỰC THI TOOL (NẾU CÓ) ===
        const toolCalls = responseMessage.tool_calls;

        if (toolCalls && toolCalls.length > 0) {
            console.log(`[Agent] LLM Call 1 yêu cầu chạy ${toolCalls.length} tool.`);
            
            messagesForLLM.push(responseMessage); 

            const toolPromises = toolCalls.map(async (toolCall) => {
                const functionName = toolCall.function.name;
                const functionArgs = JSON.parse(toolCall.function.arguments);
                let functionResponse = "";

                console.log(`[Agent] Chuẩn bị chạy tool: ${functionName} với args:`, functionArgs);

                if (functionName === "get_showtimes_for_movie") {
                    functionResponse = await get_showtimes_for_movie(functionArgs);
                } else if (functionName === "get_movies_at_cinema") {
                    functionResponse = await get_movies_at_cinema(
                        functionArgs.cinema_name,
                        functionArgs.date
                    );
                } else if (functionName === "get_movie_details") {
                     functionResponse = await get_movie_details(
                        functionArgs.movie_title
                    );
                } else if (functionName === "get_movie_recommendations_based_on_history") {
                     functionResponse = await get_movie_recommendations_based_on_history(req.user.id);
                } else {
                    console.warn(`[Agent] Không nhận diện được tool: ${functionName}`);
                    functionResponse = JSON.stringify({ error: "Tool không xác định." });
                }

                console.log(`[Agent] Kết quả tool ${functionName}: ${functionResponse.substring(0, 100)}...`);

                return {
                    role: "tool",
                    tool_call_id: toolCall.id,
                    name: functionName,
                    content: functionResponse 
                };
            });

            const toolResults = await Promise.all(toolPromises);
            
            // === SỬA LỖI LOGIC: CAN THIỆP TRƯỚC LLM CALL 2 ===
            // Kiểm tra xem tool có trả về lỗi "Không tìm thấy" hay mảng rỗng không
            let toolFailed = false;
            let failureMessage = "";
            try {
                // Chỉ kiểm tra tool đầu tiên (giả sử chỉ gọi 1 tool/lần)
                const firstResultContent = toolResults[0].content;
                const parsedResult = JSON.parse(firstResultContent);
                
                if (parsedResult.message) {
                    // Tool trả về lỗi (ví dụ: "Rất tiếc, không tìm thấy...")
                    toolFailed = true;
                    failureMessage = parsedResult.message;
                } else if (Array.isArray(parsedResult) && parsedResult.length === 0) {
                    // Tool trả về mảng rỗng `[]`
                    toolFailed = true;
                    // Tự tạo tin nhắn lỗi thân thiện hơn
                    failureMessage = "Rất tiếc, tôi không tìm thấy suất chiếu nào phù hợp với yêu cầu của bạn.";
                }
            } catch (e) {
                // Lỗi parse JSON (không nên xảy ra, nhưng để phòng hờ)
                console.error("[Agent] Lỗi parse kết quả tool:", e);
            }

            if (toolFailed) {
                // DỪNG LẠI! Không gọi LLM Call 2. 
                // Trả thẳng tin nhắn lỗi về cho người dùng.
                console.log("[Agent] Tool thất bại, trả về lỗi trực tiếp:", failureMessage);
                res.json({ reply: failureMessage });
                return; // Kết thúc hàm
            }
            // === KẾT THÚC SỬA LỖI LOGIC ===


            messagesForLLM.push(...toolResults);

            // === BƯỚC 4: LLM CALL 2 (TỔNG HỢP KẾT QUẢ) ===
            console.log("[Agent] Bắt đầu LLM Call 2 (Tổng hợp)...");
            const finalResponse = await groq.chat.completions.create({
                model: "llama-3.1-8b-instant", 
                messages: messagesForLLM 
            });

            if (finalResponse.choices[0].message.tool_calls) {
                console.error("[Agent] Lỗi: LLM Call 2 đã cố gọi tool một lần nữa.");
                res.status(500).json({ message: 'Lỗi logic: LLM cố gọi tool 2 lần.' });
            } else {
                const reply = finalResponse.choices[0].message.content;
                res.json({ reply });
            }

        } else {
            // === BƯỚC 3 (PHỤ): NẾU KHÔNG GỌI TOOL ===
            console.log("[Agent] LLM Call 1 quyết định chat.");
            const replyContent = response.choices[0].message.content || "Xin lỗi, tôi chưa thể trả lời câu hỏi này.";

            // === SỬA LOGIC: XỬ LÝ PHẢN HỒI GIAI ĐOẠN 3 ===
            if (isChotDonGiaiDoan3) {
                console.log("[Agent] Đang xử lý phản hồi Giai Đoạn 3 (JSON mode):", replyContent);
                try {
                    const choiceJson = JSON.parse(replyContent);
                    
                    // Tìm lại tin nhắn `role: "tool"` gần nhất
                    const lastToolMessage = [...conversationHistory].reverse().find(m => m.role === 'tool');
                    
                    if (!lastToolMessage) {
                        throw new Error("Không tìm thấy tin nhắn tool (suất chiếu) trong lịch sử.");
                    }

                    const allShowtimes = JSON.parse(lastToolMessage.content);
                    if (!Array.isArray(allShowtimes) || allShowtimes.length === 0) {
                        throw new Error("Dữ liệu suất chiếu (tool) bị hỏng hoặc rỗng.");
                    }

                    let selectedShowtime = null;

                    if (choiceJson.choice_index) {
                        if (choiceJson.choice_index === -1) {
                            // User từ chối
                            res.json({ reply: "Đã hiểu. Bạn cần tôi giúp gì khác không?" });
                            return;
                        }
                        // User chọn theo số thứ tự (1-based)
                        selectedShowtime = allShowtimes[choiceJson.choice_index - 1];
                    } else if (choiceJson.choice_time) {
                        // User chọn theo giờ
                        const targetTime = choiceJson.choice_time; // "13:45"
                        selectedShowtime = allShowtimes.find(st => {
                            // So sánh HH:mm
                            const stTime = new Date(st.start_time).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
                            return stTime === targetTime;
                        });
                    }

                    if (!selectedShowtime) {
                        // LLM trả về JSON nhưng ta không tìm thấy suất chiếu
                        throw new Error("Không thể ghép nối lựa chọn của user với suất chiếu.");
                    }

                    // TÌM THẤY! Gửi lại TOÀN BỘ JSON (bọc trong mảng)
                    console.log("[Agent] Đã tìm thấy suất chiếu:", selectedShowtime.showtime_id);
                    res.json({ reply: JSON.stringify([selectedShowtime]) }); // Gửi JSON đầy đủ

                } catch (e) {
                    console.error("[Agent] Lỗi nghiêm trọng Giai Đoạn 3:", e.message, replyContent);
                    // Fallback nếu LLM trả về Giai đoạn 3 bị lỗi
                    res.json({ reply: "Rất tiếc, tôi không hiểu lựa chọn của bạn. Vui lòng thử lại bằng cách nói rõ giờ chiếu (ví dụ: 'chọn suất 13:45')." });
                }
            } else {
                // Giai Đoạn 1/2 (Chat bình thường)
                res.json({ reply: replyContent });
            }
            // === KẾT THÚC SỬA LOGIC ===
        }

    } catch (err) {
        console.error("Lỗi API Chat:", err);
        if (err instanceof Groq.APIError) {
             console.error("Chi tiết lỗi Groq:", err.response ? await err.response.text() : err.message);
             return res.status(500).json({ message: 'Lỗi từ nhà cung cấp AI. Có thể bạn đã vượt giới hạn (rate limit) hoặc prompt có vấn đề.' });
        }
        res.status(500).json({ message: 'Lỗi server khi xử lý yêu cầu chat.' });
    }
});


// === CÁC API KHÁC (Được giữ nguyên) ===
// 1. API gốc
app.get('/', (req, res) => res.send('Backend server CGV đã chạy thành công!'));

// 2. API Đăng ký
app.post('/api/auth/register', async (req, res) => {
    // SỬA: Bổ sung các trường mới từ req.body
    const { name, email, password, phone, birthday, address, gender } = req.body;
    
    if (!name || !email || !password) return res.status(400).json({ message: 'Vui lòng cung cấp đủ thông tin bắt buộc.' });

    // SỬA: Xử lý giá trị null/undefined cho các trường tùy chọn
    // Nếu giá trị là chuỗi rỗng "", chuyển thành null để DB chấp nhận
    const birthdayValue = birthday ? birthday : null;
    const phoneValue = phone ? phone : null;
    const addressValue = address ? address : null;
    const genderValue = gender ? gender : 'other'; // Đặt 'other' làm mặc định

    try {
        const salt = await bcrypt.genSalt(10);
        const password_hash = await bcrypt.hash(password.trim(), salt);
        
        // SỬA: Cập nhật câu query INSERT
        const newUserQuery = `
            INSERT INTO Users (username, email, password_hash, phone, birthday, address, gender) 
            VALUES ($1, $2, $3, $4, $5, $6, $7) 
            RETURNING user_id, username, email;
        `;
        
        // SỬA: Cập nhật mảng values
        const values = [
            name.trim(), 
            email.trim().toLowerCase(), 
            password_hash,
            phoneValue,
            birthdayValue,
            addressValue,
            genderValue
        ];
        
        const result = await pool.query(newUserQuery, values);
        res.status(201).json({ message: 'Tạo tài khoản thành công!', user: result.rows[0] });
    } catch (err) {
        // Đây là thông báo lỗi chúng ta đã sửa ở bước trước
        if (err.code === '23505') return res.status(400).json({ message: 'Email này đã tồn tại. Vui lòng sử dụng email khác.' });
        console.error(err);
        res.status(500).json({ message: 'Lỗi server.' });
    }
});


// 3. API Đăng nhập
app.post('/api/auth/login', async (req, res) => {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ message: 'Vui lòng cung cấp email và mật khẩu.' });
    try {
        const userQuery = 'SELECT * FROM Users WHERE email = $1';
        const result = await pool.query(userQuery, [email.trim().toLowerCase()]);
        if (result.rows.length === 0) return res.status(401).json({ message: 'Email hoặc mật khẩu không chính xác.' });
        const user = result.rows[0];
        const isMatch = await bcrypt.compare(password.trim(), user.password_hash);
        if (!isMatch) return res.status(401).json({ message: 'Email hoặc mật khẩu không chính xác.' });
        const payload = { user: { id: user.user_id, name: user.username, email: user.email } };
        jwt.sign(payload, process.env.JWT_SECRET, { expiresIn: '7d' }, (err, token) => {
            if (err) throw err;
            res.status(200).json({ message: 'Đăng nhập thành công!', token: token, user: payload.user });
        });
    } catch (err) {
        console.error(err);
        res.status(500).json({ message: 'Lỗi server.' });
    }
});

// 4. API Lấy thông tin người dùng
app.get('/api/users/me', authMiddleware, async (req, res) => {
    try {
        const userQuery = 'SELECT user_id, username, email, phone, birthday, address, gender FROM Users WHERE user_id = $1';
        const result = await pool.query(userQuery, [req.user.id]);
        if (result.rows.length === 0) return res.status(404).json({ message: 'Không tìm thấy người dùng.' });
        // Format birthday before sending
        const user = result.rows[0];
        if (user.birthday) {
             user.birthday = new Date(user.birthday).toISOString().split('T')[0]; // Format YYYY-MM-DD
        }
        res.json(user);
    } catch (err) {
        console.error(err);
        res.status(500).json({ message: 'Lỗi server.' });
    }
});

// 5. API Cập nhật thông tin người dùng
app.put('/api/users/me', authMiddleware, async (req, res) => {
    const { name, phone, birthday, address, gender } = req.body;
    try {
        const birthdayValue = birthday ? birthday : null; // Handle null birthday
        const updateUserQuery = `
            UPDATE Users 
            SET username = $1, phone = $2, birthday = $3, address = $4, gender = $5 
            WHERE user_id = $6 
            RETURNING user_id, username, email, phone, birthday, address, gender;
        `;
        const values = [name, phone, birthdayValue, address, gender, req.user.id];
        const result = await pool.query(updateUserQuery, values);
        // Format birthday before sending back
        const updatedUser = result.rows[0];
         if (updatedUser.birthday) {
             updatedUser.birthday = new Date(updatedUser.birthday).toISOString().split('T')[0];
         }
        res.json({ message: 'Cập nhật thông tin thành công!', user: updatedUser });
    } catch (err) {
        console.error(err);
        res.status(500).json({ message: 'Lỗi server.' });
    }
});

// 6. API Lấy lịch sử đặt vé (ĐÃ CẬP NHẬT)
app.get('/api/users/me/bookings', authMiddleware, async (req, res) => {
    try {
        const bookingsQuery = `
            SELECT 
                b.booking_id, 
                m.title AS movie_title, 
                m.poster_url,
                m.genre,
                c.name AS cinema_name, 
                s.start_time, 
                b.total_amount,
                b.seats 
            FROM Bookings b 
            JOIN Showtimes s ON b.showtime_id = s.showtime_id 
            JOIN Movies m ON s.movie_id = m.movie_id
            JOIN Cinemas c ON s.cinema_id = c.cinema_id 
            WHERE b.user_id = $1 
            ORDER BY s.start_time DESC;
        `;
        const result = await pool.query(bookingsQuery, [req.user.id]);
        res.json(result.rows);
    } catch (err) {
        console.error("Lỗi API get bookings:", err);
        res.status(500).json({ message: 'Lỗi server.' });
    }
});

// 7. API Lấy danh sách phim (Phiên bản đã sửa lỗi)
app.get('/api/movies', async (req, res) => {
    try {
        const { status } = req.query;
        let query = 'SELECT * FROM Movies ORDER BY release_date DESC';
        
        if (status === 'now-showing') {
            query = "SELECT * FROM Movies WHERE release_date <= CURRENT_DATE ORDER BY release_date DESC";
        } else if (status === 'coming-soon') {
            query = "SELECT * FROM Movies WHERE release_date > CURRENT_DATE ORDER BY release_date ASC";
        }
        
        const result = await pool.query(query);
        // Chuyển đổi định dạng ngày tháng ở phía server trước khi gửi đi
        const movies = result.rows.map(movie => ({
            ...movie,
            // Đảm bảo chỉ chuyển đổi nếu release_date không null
            release_date: movie.release_date ? movie.release_date.toISOString().split('T')[0] : null
        }));

        res.json(movies);
    } catch (err) {
        console.error(err);
        res.status(500).json({ message: 'Lỗi server.' });
    }
});

// 8. API Lấy danh sách thành phố (Đã sửa để trả về count)
app.get('/api/cinemas/cities', async (req, res) => {
    try {
        const query = 'SELECT city, COUNT(cinema_id)::text as count FROM Cinemas GROUP BY city ORDER BY city'; // Cast count to text
        const result = await pool.query(query);
        res.json(result.rows);
    } catch (err) {
        console.error("Lỗi API get cities:", err);
        res.status(500).json({ message: 'Lỗi server.' });
    }
});

// 9. API Lấy danh sách rạp phim
app.get('/api/cinemas', async (req, res) => {
    try {
        const { city } = req.query;
        let query = 'SELECT * FROM Cinemas ORDER BY name';
        let values = [];
        if (city && city !== 'all') {
            query = 'SELECT * FROM Cinemas WHERE city = $1 ORDER BY name';
            values.push(city);
        }
        const result = await pool.query(query, values);
        res.json(result.rows);
    } catch (err) {
        console.error(err);
        res.status(500).json({ message: 'Lỗi server.' });
    }
});


// 11. API để lấy thông tin chi tiết của một phim
app.get('/api/movies/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const query = "SELECT *, to_char(release_date, 'YYYY-MM-DD') as release_date FROM Movies WHERE movie_id = $1";
        const result = await pool.query(query, [id]);

        if (result.rows.length === 0) {
            return res.status(404).json({ message: 'Không tìm thấy phim.' });
        }
        res.json(result.rows[0]);
    } catch (err) {
        console.error(err);
        res.status(500).json({ message: 'Lỗi server.' });
    }
});

// 12. API để lấy suất chiếu của một phim (Đã cập nhật để bao gồm thành phố)
app.get('/api/movies/:id/showtimes', async (req, res) => {
    try {
        const { id } = req.params;
        const query = `
            SELECT 
                s.showtime_id,
                s.start_time,
                s.ticket_price,
                c.name as cinema_name,
                c.city
            FROM Showtimes s
            JOIN Cinemas c ON s.cinema_id = c.cinema_id
            WHERE s.movie_id = $1 AND s.start_time > NOW() 
            ORDER BY c.city, c.name, s.start_time;
        `;
        const result = await pool.query(query, [id]);
        res.json(result.rows);
    } catch (err) {
        console.error("Lỗi khi lấy suất chiếu cho phim:", err);
        res.status(500).json({ message: 'Lỗi server.' });
    }
});


// 13. API để tạo một booking mới (PHIÊN BẢN CÓ TRANSACTION - ĐÃ SỬA LỖI)
app.post('/api/bookings', authMiddleware, async (req, res) => {
    const { showtime_id, seats } = req.body; // `seats` là một mảng, ví dụ: ['H8', 'H9']
    const userId = req.user.id;

    if (!showtime_id || !seats || !Array.isArray(seats) || seats.length === 0) {
        return res.status(400).json({ message: 'Vui lòng cung cấp đủ thông tin suất chiếu và ghế ngồi.' });
    }

    const client = await pool.connect();

    try {
        // BẮT ĐẦU TRANSACTION
        await client.query('BEGIN');

        // 1. Kiểm tra xem có ghế nào đã được đặt chưa (Sử dụng FOR UPDATE để khóa dòng)
        const checkSeatsQuery = `SELECT seat_id FROM booked_seats WHERE showtime_id = $1 AND seat_id = ANY($2::text[]) FOR UPDATE`;
        const existingSeatsResult = await client.query(checkSeatsQuery, [showtime_id, seats]);

        if (existingSeatsResult.rows.length > 0) {
            const occupied = existingSeatsResult.rows.map(r => r.seat_id).join(', ');
            // SỬA LỖI: Ném lỗi để ROLLBACK và gửi mã lỗi 409
            await client.query('ROLLBACK'); // Hủy transaction
            return res.status(409).json({ message: `Ghế ${occupied} đã có người đặt. Vui lòng chọn ghế khác.` });
        }

        // 2. Lấy giá vé và tính tổng tiền
        const showtimeQuery = 'SELECT ticket_price FROM showtimes WHERE showtime_id = $1';
        const showtimeResult = await client.query(showtimeQuery, [showtime_id]);
        if (showtimeResult.rows.length === 0) {
             // SỬA LỖI: Ném lỗi để ROLLBACK và gửi mã lỗi 404
            await client.query('ROLLBACK');
            return res.status(404).json({ message: 'Không tìm thấy suất chiếu.' });
        }
        
        // Sửa lỗi tính toán: Dùng giá vé từ DB, *không* dùng hàm logic giá vé cứng ở frontend
        const ticketPrice = parseFloat(showtimeResult.rows[0].ticket_price);
        // Đơn giản hóa: Mọi vé có cùng giá
        const totalAmount = ticketPrice * seats.length; 

        // 3. Tạo một bản ghi mới trong bảng `bookings` với cột `seats`
        const newBookingQuery = `
            INSERT INTO bookings (user_id, showtime_id, total_amount, seats)
            VALUES ($1, $2, $3, $4)
            RETURNING booking_id;
        `;
        const bookingValues = [userId, showtime_id, totalAmount, seats];
        const bookingResult = await client.query(newBookingQuery, bookingValues);
        const newBookingId = bookingResult.rows[0].booking_id;

        // 4. Thêm từng ghế đã đặt vào bảng `booked_seats`
        // (Sử dụng vòng lặp for...of để đảm bảo tuần tự)
        for (const seat_id of seats) {
            const bookSeatQuery = `
                INSERT INTO booked_seats (booking_id, showtime_id, seat_id)
                VALUES ($1, $2, $3);
            `;
            await client.query(bookSeatQuery, [newBookingId, showtime_id, seat_id]);
        }
        
        // 5. Cập nhật lại số ghế trống trong bảng `showtimes`
        const updateShowtimeQuery = `
            UPDATE showtimes 
            SET available_seats = available_seats - $1 
            WHERE showtime_id = $2;
        `;
        await client.query(updateShowtimeQuery, [seats.length, showtime_id]);

        // KẾT THÚC TRANSACTION, LƯU TẤT CẢ THAY ĐỔI
        await client.query('COMMIT');

        res.status(201).json({
            message: 'Đặt vé thành công!',
            bookingId: newBookingId,
        });

    } catch (err) {
        // Nếu có bất kỳ lỗi nào khác (ngoài lỗi đã xử lý ở trên), hủy bỏ tất cả thay đổi
        await client.query('ROLLBACK');
        console.error("Lỗi khi tạo booking:", err);
        // Gửi thông báo lỗi server chung chung
        res.status(500).json({ message: 'Lỗi server khi đặt vé.' });
    } finally {
        // Luôn giải phóng kết nối sau khi hoàn tất
        client.release();
    }
});

// API 15: Lấy danh sách khuyến mãi
app.get('/api/promotions', async (req, res) => {
    try {
        const query = 'SELECT *, to_char(valid_until, \'YYYY-MM-DD\') as valid_until FROM Promotions ORDER BY featured DESC, valid_until ASC';
        const result = await pool.query(query);
        res.json(result.rows);
    } catch (err) {
        console.error("Lỗi khi lấy danh sách khuyến mãi:", err);
        res.status(500).json({ message: 'Lỗi server.' });
    }
});

// API 16: Lấy danh sách sự kiện (ĐÃ SỬA LỖI)
app.get('/api/events', async (req, res) => {
    try {
        const query = `
            SELECT 
                *, 
                to_char(event_date, 'YYYY-MM-DD') as event_date 
            FROM Events 
            WHERE event_date > NOW() 
            ORDER BY Events.event_date ASC`; 
        const result = await pool.query(query);
        res.json(result.rows);
    } catch (err) {
        console.error("Lỗi khi lấy danh sách sự kiện:", err);
        res.status(500).json({ message: 'Lỗi server.' });
    }
});

// API 17: Lấy lịch chiếu tổng hợp cho một rạp vào một ngày
app.get('/api/showtimes-by-cinema', async (req, res) => {
    const { cinemaId, date } = req.query; // date có định dạng YYYY-MM-DD

    if (!cinemaId || !date) {
        return res.status(400).json({ message: 'Vui lòng cung cấp cinemaId và date.' });
    }

    try {
        const query = `
            SELECT
                m.movie_id, m.title, m.genre, m.duration_minutes, m.rating, m.age_rating, m.poster_url, m.features,
                json_agg(
                    json_build_object(
                        'showtime_id', s.showtime_id,
                        'start_time', s.start_time,
                        'ticket_price', s.ticket_price
                    ) ORDER BY s.start_time
                ) AS times
            FROM Movies m
            JOIN Showtimes s ON m.movie_id = s.movie_id
            WHERE s.cinema_id = $1 
              AND s.start_time >= ($2::date) 
              AND s.start_time < ($2::date + interval '1 day')
              AND s.start_time > NOW()
            GROUP BY m.movie_id
            ORDER BY m.title;
        `;
        const result = await pool.query(query, [cinemaId, date]);
        res.json(result.rows);
    } catch (err) {
        console.error('Lỗi khi lấy lịch chiếu theo rạp:', err);
        res.status(500).json({ message: 'Lỗi server.' });
    }
});

// API 18: Lấy danh sách các ghế đã bị chiếm cho một suất chiếu cụ thể
app.get('/api/showtimes/:showtimeId/occupied-seats', async (req, res) => {
    const { showtimeId } = req.params;
    try {
        const query = 'SELECT seat_id FROM booked_seats WHERE showtime_id = $1';
        const result = await pool.query(query, [showtimeId]);
        res.json(result.rows.map(row => row.seat_id));
    } catch (err) {
        console.error('Lỗi khi lấy danh sách ghế đã chiếm:', err);
        res.status(500).json({ message: 'Lỗi server.' });
    }
});

// API MỚI: Đặt vé sự kiện
app.post('/api/events/bookings', authMiddleware, async(req, res) => {
     const { event_id, number_of_tickets, total_amount } = req.body;
     const userId = req.user.id;

     if (!event_id || !number_of_tickets || number_of_tickets <= 0 || !total_amount) {
         return res.status(400).json({ message: 'Thông tin đặt vé sự kiện không hợp lệ.' });
     }

     const client = await pool.connect();
     try {
         await client.query('BEGIN');

         // Tạo booking sự kiện
         const insertBookingQuery = `
            INSERT INTO event_bookings (user_id, event_id, number_of_tickets, total_amount) 
            VALUES ($1, $2, $3, $4) 
            RETURNING event_booking_id;
         `;
         const bookingResult = await client.query(insertBookingQuery, [userId, event_id, number_of_tickets, total_amount]);
         const newBookingId = bookingResult.rows[0].event_booking_id;

         await client.query('COMMIT');
         res.status(201).json({ message: 'Đặt vé sự kiện thành công!', bookingId: newBookingId });

     } catch (err) {
         await client.query('ROLLBACK');
         console.error("Lỗi khi đặt vé sự kiện:", err);
         res.status(500).json({ message: err.message || 'Lỗi server khi đặt vé sự kiện.' });
     } finally {
         client.release();
     }
});


// Lắng nghe server
app.listen(port, () => {
    console.log(`Server đang chạy tại http://localhost:${port}`);
});