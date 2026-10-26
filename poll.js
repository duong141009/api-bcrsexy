const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const https = require('https');
const puppeteer = require('puppeteer');
const axios = require('axios');

// ================= CẤU HÌNH (SỬA Ở ĐÂY) =================
const LOGIN_CONFIG = {
    url: "https://toolbcr88.com/",
    username: "duong1410", // <--- ĐIỀN VÀO ĐÂY
    password: "duong1410"       // <--- ĐIỀN VÀO ĐÂY
};

const BCR_URL = "https://toolbcr88.com/baccarat/getnewresult"
const PORT = process.env.PORT || 5000;

// ================= GLOBAL VARIABLES ===================
let CURRENT_HEADERS = {
    "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
    "Accept": "*/*",
    "X-Requested-With": "XMLHttpRequest",
    "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    "Cookie": "",
    "X-CSRF-TOKEN": "",
    "Origin": "https://toolbcr88.com",
    "Referer": "https://toolbcr88.com/ae/lobby"
};

let TABLE_DATA = {}; // In-memory storage

const httpsAgent = new https.Agent({
    keepAlive: true,
    keepAliveMsecs: 1000,
    timeout: 30000
});

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ================= AUTO LOGIN =================
async function autoLoginAndGetHeaders() {
    console.log("\n🤖 Đang khởi động Chrome...");
    const executablePath = process.env.PUPPETEER_EXECUTABLE_PATH || null;

    const launchOptions = {
        headless: "new",
        defaultViewport: null,
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-accelerated-2d-canvas',
            '--disable-gpu'
        ]
    };

    if (executablePath) {
        launchOptions.executablePath = executablePath;
    }

    const browser = await puppeteer.launch(launchOptions);

    try {
        const page = await browser.newPage();
        page.setDefaultNavigationTimeout(60000);
        page.setDefaultTimeout(60000);

        console.log(`🤖 Đang truy cập ${LOGIN_CONFIG.url}...`);
        await page.goto(LOGIN_CONFIG.url, { waitUntil: 'domcontentloaded', timeout: 60000 });
        await sleep(5000);

        console.log("🤖 Đang thực hiện đăng nhập ngầm qua Javascript...");
        await page.evaluate((u, p) => {
            const userEl = document.querySelector('#txtUsername');
            const passEl = document.querySelector('#txtPassword');
            if (userEl) userEl.value = u;
            if (passEl) passEl.value = p;
            if (typeof do_login === 'function') {
                do_login();
            } else if (document.querySelector('.btn-confirm')) {
                document.querySelector('.btn-confirm').click();
            }
        }, LOGIN_CONFIG.username, LOGIN_CONFIG.password);

        console.log("⏳ Đang chờ hệ thống xử lý đăng nhập (5s)...");
        await sleep(5000);

        console.log("🤖 Đang chuyển hướng vào Lobby Sexy (AE)...");
        await page.goto("https://toolbcr88.com/ae/lobby", { waitUntil: 'domcontentloaded', timeout: 60000 });
        await sleep(5000);

        console.log("🤖 Đang trích xuất Token...");
        const cookies = await page.cookies();
        const cookieString = cookies.map(c => `${c.name}=${c.value}`).join('; ');

        let csrfToken = await page.evaluate(() => {
            const el = document.querySelector('meta[name="csrf-token"]');
            return el ? el.content : null;
        });

        if (!csrfToken) {
            console.log("⚠️ Chưa có Token, thử reload...");
            await page.reload({ waitUntil: 'domcontentloaded' });
            await sleep(5000);
            csrfToken = await page.evaluate(() => document.querySelector('meta[name="csrf-token"]')?.content);
        }

        if (!csrfToken) {
            csrfToken = await page.evaluate(() => window.Laravel?.csrfToken || "");
        }

        if (!csrfToken) throw new Error("Login thất bại: Không tìm thấy CSRF Token.");

        CURRENT_HEADERS["Cookie"] = cookieString;
        CURRENT_HEADERS["X-CSRF-TOKEN"] = csrfToken;

        console.log(`✅ Login thành công! Token: ${csrfToken.substring(0, 10)}...`);
        await browser.close();

    } catch (error) {
        console.log(`❌ Lỗi Auto Login: ${error.message}`);
        if (typeof browser !== 'undefined' && browser) {
            await browser.close().catch(() => { });
        }
        throw error;
    }
}

// ================= CÁC HÀM HỖ TRỢ =================

async function fetchWithRetry(url, options, retries = 3) {
    try {
        options.headers = CURRENT_HEADERS;
        const res = await fetch(url, { ...options, agent: httpsAgent, redirect: 'manual' });

        if (res.status === 401 || res.status === 419 || res.status === 301 || res.status === 302) {
            console.log(`\n⚠️ Token hết hạn hoặc bị chuyển hướng (${res.status}). Đang tự động Login lại...`);
            await autoLoginAndGetHeaders();
            return fetchWithRetry(url, options, retries);
        }

        if (res.url && res.url.includes('/login')) {
            console.log("\n⚠️ Bị chuyển hướng tới trang đăng nhập. Đang tự động Login lại...");
            await autoLoginAndGetHeaders();
            return fetchWithRetry(url, options, retries);
        }

        if (!res.ok) throw new Error(`HTTP Error: ${res.status}`);

        const contentType = res.headers.get("content-type");
        if (contentType && contentType.includes("text/html")) {
            console.log("\n⚠️ API trả về HTML thay vì JSON (có thể session bị lỗi). Đang tự động Login lại...");
            await autoLoginAndGetHeaders();
            return fetchWithRetry(url, options, retries);
        }

        return await res.json();

    } catch (err) {
        if (retries > 0) {
            console.log(`\n⚠️ Lỗi kết nối (${err.message}). Thử lại... (${retries})`);
            await sleep(2000);
            return fetchWithRetry(url, options, retries - 1);
        }
        throw err;
    }
}

// ================= VÒNG LẶP CHÍNH ==================
async function pollLoop() {
    console.log("==========================================");
    console.log("🚀 AE-SEXY Baccarat Poller Started");
    console.log("==========================================");

    try {
        await autoLoginAndGetHeaders();
    } catch (e) {
        console.log("❌ Dừng chương trình do lỗi Login ban đầu. Thử lại sau 30s...");
        setTimeout(pollLoop, 30000);
        return;
    }

    while (true) {
        try {
            const json = await fetchWithRetry(BCR_URL, {
                method: "POST",
                body: "gameCode=ae"
            });

            if (json?.data) {
                let updated = 0;
                const newTableData = {};

                for (const table of json.data) {
                    const displayName = table.table_name;
                    const newResults = table.result || "";
                    const goodRoad = table.goodRoad || "";

                    let pCount = 0, tCount = 0, bCount = 0;
                    let maxStreak = 0, currentStreakCount = 0, currentStreakChar = "";
                    let longestStreakChar = "";

                    if (newResults) {
                        const arr = newResults.split('');
                        pCount = arr.filter(c => c === 'P').length;
                        tCount = arr.filter(c => c === 'T').length;
                        bCount = arr.filter(c => c === 'B').length;

                        let tempStreak = 0;
                        let lastChar = "";
                        for (let i = 0; i < arr.length; i++) {
                            if (arr[i] === lastChar) {
                                tempStreak++;
                            } else {
                                if (tempStreak > maxStreak) {
                                    maxStreak = tempStreak;
                                    longestStreakChar = lastChar;
                                }
                                tempStreak = 1;
                                lastChar = arr[i];
                            }
                        }
                        if (tempStreak > maxStreak) {
                            maxStreak = tempStreak;
                            longestStreakChar = lastChar;
                        }

                        currentStreakChar = arr[arr.length - 1];
                        currentStreakCount = 0;
                        for (let i = arr.length - 1; i >= 0; i--) {
                            if (arr[i] === currentStreakChar) currentStreakCount++;
                            else break;
                        }
                    }

                    const vnTime = new Date().toLocaleString("vi-VN", { timeZone: "Asia/Ho_Chi_Minh" });
                    const isNew = !TABLE_DATA[displayName] || TABLE_DATA[displayName].results !== newResults;

                    newTableData[displayName] = {
                        cau: goodRoad,
                        results: newResults,
                        time: vnTime,
                        table_id: table.table_id,
                        stats: {
                            p_count: pCount,
                            t_count: tCount,
                            b_count: bCount,
                            total: pCount + tCount + bCount,
                            longest_streak: maxStreak > 0 ? `${maxStreak}${longestStreakChar}` : "0",
                            current_streak: currentStreakCount > 0 ? `${currentStreakCount}${currentStreakChar}` : "0"
                        }
                    };

                    if (isNew) updated++;
                }

                TABLE_DATA = newTableData;
                if (updated > 0) console.log(`[📡] Cập nhật: ${updated} bàn mới. Tổng: ${Object.keys(TABLE_DATA).length} bàn.`);
            } else {
                console.log(`⚠ API trả về rỗng hoặc sai cấu trúc.`);
            }

        } catch (error) {
            console.log(`❌ Lỗi cycle:`, error.message);
        }
        await sleep(5000);
    }
}

// ================= EXPRESS SERVER =================
const app = express();
app.use(cors());
app.use(express.json());

// API: Lấy tất cả dữ liệu bàn
app.get('/api/baccarat', (req, res) => {
    res.json(TABLE_DATA);
});

// API: Lấy dữ liệu 1 bàn cụ thể
app.get('/api/baccarat/:tableName', (req, res) => {
    const tableId = req.params.tableName.toUpperCase();
    if (TABLE_DATA[tableId]) {
        res.json(TABLE_DATA[tableId]);
    } else {
        res.status(404).json({ cau: "", results: "" });
    }
});

// Landing Page Dashboard
app.get('/', (req, res) => {
    res.send(`
<!DOCTYPE html>
<html lang="vi">
<head>
    <title>AE-SEXY Baccarat — Live Dashboard</title>
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <meta charset="UTF-8">
    <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800;900&display=swap" rel="stylesheet">
    <style>
        *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

        body {
            font-family: 'Inter', sans-serif;
            background: #1a0a0a;
            background-image:
                radial-gradient(ellipse at 30% 20%, rgba(180, 40, 20, 0.15) 0%, transparent 50%),
                radial-gradient(ellipse at 70% 80%, rgba(120, 20, 10, 0.1) 0%, transparent 50%);
            color: #fff;
            min-height: 100vh;
            overflow-x: hidden;
        }

        .container {
            max-width: 1500px;
            margin: 0 auto;
            padding: 16px;
        }

        /* ===== HEADER ===== */
        .header {
            text-align: center;
            padding: 28px 20px 22px;
            margin-bottom: 20px;
            background: linear-gradient(135deg, #8b1a1a 0%, #5c1010 50%, #3a0808 100%);
            border-radius: 16px;
            border: 1px solid rgba(255,180,80,0.2);
            position: relative;
            overflow: hidden;
            box-shadow: 0 8px 32px rgba(0,0,0,0.5);
        }

        .header::before {
            content: '';
            position: absolute;
            top: 0; left: 0; right: 0;
            height: 3px;
            background: linear-gradient(90deg, #ffd700, #ff8c00, #ffd700);
        }

        .header h1 {
            font-size: clamp(1.5rem, 4vw, 2.5rem);
            font-weight: 900;
            background: linear-gradient(to right, #ffd700, #ffaa00);
            -webkit-background-clip: text;
            -webkit-text-fill-color: transparent;
            background-clip: text;
            margin-bottom: 8px;
        }

        .header-info {
            display: flex;
            justify-content: center;
            gap: 20px;
            flex-wrap: wrap;
            font-size: 0.85rem;
        }

        .header-info .info-item {
            display: flex;
            align-items: center;
            gap: 6px;
            color: rgba(255,255,255,0.8);
        }

        .info-dot {
            width: 8px; height: 8px;
            border-radius: 50%;
            animation: pulse-dot 2s infinite;
        }

        .info-dot.green { background: #4ade80; box-shadow: 0 0 8px #4ade80; }
        .info-dot.gold { background: #ffd700; box-shadow: 0 0 8px #ffd700; }

        @keyframes pulse-dot {
            0%, 100% { opacity: 1; transform: scale(1); }
            50% { opacity: 0.5; transform: scale(0.8); }
        }

        #liveClock {
            font-family: 'Consolas', monospace;
            color: #ffd700;
            font-weight: 600;
        }

        /* ===== CONTROLS ===== */
        .controls {
            display: flex;
            justify-content: center;
            margin-bottom: 20px;
        }

        .btn-api {
            display: inline-flex;
            align-items: center;
            gap: 8px;
            padding: 10px 24px;
            border-radius: 10px;
            background: linear-gradient(135deg, #8b1a1a, #c0392b);
            color: #ffd700;
            text-decoration: none;
            font-weight: 700;
            font-size: 0.85rem;
            border: 1px solid rgba(255,215,0,0.3);
            transition: all 0.3s;
        }

        .btn-api:hover {
            transform: translateY(-2px);
            box-shadow: 0 4px 16px rgba(192,57,43,0.4);
        }

        /* ===== SECTION TITLE ===== */
        .section-header {
            display: flex;
            align-items: center;
            gap: 12px;
            margin: 24px 0 14px;
        }

        .section-header h2 {
            font-size: 1rem;
            font-weight: 800;
            color: #ffd700;
            white-space: nowrap;
        }

        .section-header .divider {
            flex: 1;
            height: 1px;
            background: linear-gradient(to right, rgba(255,215,0,0.3), transparent);
        }

        .section-header .badge {
            background: rgba(255,215,0,0.12);
            color: #ffd700;
            padding: 3px 12px;
            border-radius: 100px;
            font-size: 0.72rem;
            font-weight: 700;
            border: 1px solid rgba(255,215,0,0.2);
        }

        /* ===== TABLE GRID ===== */
        .grid {
            display: grid;
            grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
            gap: 12px;
        }

        /* ===== TABLE CARD — giống hình mẫu ===== */
        .card-link {
            text-decoration: none;
            color: inherit;
            display: block;
        }

        .table-card {
            background: #fff;
            border-radius: 10px;
            overflow: hidden;
            border: 2px solid #8b1a1a;
            transition: all 0.3s ease;
            position: relative;
        }

        .card-link:hover .table-card {
            transform: translateY(-3px);
            box-shadow: 0 8px 24px rgba(0,0,0,0.4);
            border-color: #ffd700;
        }

        /* Card top bar — đỏ đậm */
        .card-top {
            background: linear-gradient(135deg, #8b1a1a, #a31d1d);
            padding: 6px 10px;
            display: flex;
            justify-content: space-between;
            align-items: center;
        }

        .card-top .table-name {
            font-size: 0.8rem;
            font-weight: 800;
            color: #fff;
            letter-spacing: 0.5px;
        }

        .card-top .table-name .new-tag {
            background: #ff0;
            color: #8b1a1a;
            font-size: 0.55rem;
            padding: 1px 5px;
            border-radius: 3px;
            font-weight: 900;
            margin-right: 6px;
            vertical-align: middle;
        }

        .card-top .hand-count {
            font-size: 0.7rem;
            color: rgba(255,255,255,0.7);
            display: flex;
            align-items: center;
            gap: 4px;
        }

        .card-top .hand-count .count-num {
            color: #ffd700;
            font-weight: 800;
        }

        /* Road board container & 12x6 grid */
        .road-container {
            position: relative;
            background: #fff;
            width: 100%;
        }

        .road-grid {
            display: grid;
            grid-template-columns: repeat(12, 1fr);
            grid-template-rows: repeat(6, 1fr);
            grid-auto-flow: column;
            background: #ffffff;
            border: 1.5px solid #94a3b8; /* Viền bao ngoài ô vuông rõ nét */
            width: 100%;
            aspect-ratio: 12 / 6;
            box-sizing: border-box;
        }

        .road-cell {
            border-right: 1px solid #b8c7d9; /* Đường kẻ phân chia ô vuông rõ nét */
            border-bottom: 1px solid #b8c7d9;
            display: flex;
            align-items: center;
            justify-content: center;
            position: relative;
            box-sizing: border-box;
        }

        /* Ẩn viền phải ở cột thứ 12 */
        .road-cell:nth-child(n+67) {
            border-right: none;
        }

        /* Ẩn viền dưới ở hàng thứ 6 */
        .road-cell:nth-child(6n) {
            border-bottom: none;
        }

        /* Vòng tròn rỗng ruột nằm gọn gàng bên trong ô vuông */
        .bead-ring {
            width: 72%;
            height: 72%;
            max-width: 16px;
            max-height: 16px;
            border-radius: 50%;
            position: relative;
            box-sizing: border-box;
            display: flex;
            align-items: center;
            justify-content: center;
            flex-shrink: 0;
            overflow: hidden; /* Cắt gọn gàng bên trong vòng tròn */
        }

        /* Cái (B) = viền đỏ rỗng ruột */
        .bead-ring.bead-B {
            background: transparent;
            border: 2px solid #dc2626;
        }

        /* Con (P) = viền xanh dương rỗng ruột */
        .bead-ring.bead-P {
            background: transparent;
            border: 2px solid #2563eb;
        }

        /* 1 Hòa: 1 gạch chéo xanh lá nằm gọn bên trong vòng tròn */
        .bead-ring.has-tie-single::after {
            content: '';
            position: absolute;
            top: 50%;
            left: 50%;
            width: 100%;
            height: 2px;
            background: #16a34a;
            transform: translate(-50%, -50%) rotate(-45deg);
            z-index: 2;
        }

        /* 2 Hòa trở lên: 2 gạch chéo song song */
        .bead-ring.has-tie-multi::before {
            content: '';
            position: absolute;
            top: 50%;
            left: 50%;
            width: 100%;
            height: 1.8px;
            background: #16a34a;
            transform: translate(-50%, -50%) rotate(-45deg) translateY(-3.5px);
            z-index: 1;
        }

        .bead-ring.has-tie-multi::after {
            content: '';
            position: absolute;
            top: 50%;
            left: 50%;
            width: 100%;
            height: 1.8px;
            background: #16a34a;
            transform: translate(-50%, -50%) rotate(-45deg) translateY(3.5px);
            z-index: 1;
        }

        /* Số hiển thị ở giữa 2 gạch khi hòa >= 2 */
        .bead-ring .tie-center-num {
            position: absolute;
            top: 50%;
            left: 50%;
            transform: translate(-50%, -50%);
            font-size: 8px;
            font-weight: 900;
            color: #16a34a;
            line-height: 1;
            z-index: 3;
            background: #ffffff;
            border-radius: 2px;
            padding: 0 1px;
        }

        /* Good Road ribbon phong cách casino như ảnh */
        .good-road-ribbon {
            position: absolute;
            bottom: 4px;
            right: 4px;
            background: linear-gradient(135deg, #b45309 0%, #f59e0b 50%, #92400e 100%);
            color: #ffffff;
            font-weight: 900;
            font-style: italic;
            font-size: 0.72rem;
            padding: 2px 8px;
            border-radius: 4px;
            box-shadow: 0 2px 6px rgba(0,0,0,0.4);
            letter-spacing: 0.5px;
            pointer-events: none;
            z-index: 10;
            text-shadow: 0 1px 2px rgba(0,0,0,0.6);
            border: 1px solid rgba(255,215,0,0.4);
        }

        /* Bottom stats bar giống hình mẫu (màu hổ phách caramel) */
        .card-bottom {
            display: flex;
            justify-content: space-between;
            align-items: center;
            padding: 5px 10px;
            background: linear-gradient(135deg, #a35010 0%, #cc701b 50%, #a35010 100%);
            color: #ffffff;
            border-top: 1px solid rgba(0,0,0,0.15);
        }

        .stat-group {
            display: flex;
            align-items: center;
            gap: 10px;
        }

        .stat-pill {
            display: inline-flex;
            align-items: center;
            gap: 4px;
            font-size: 0.75rem;
            font-weight: 800;
        }

        .stat-dot {
            width: 15px;
            height: 15px;
            border-radius: 50%;
            display: flex;
            align-items: center;
            justify-content: center;
            font-size: 0.58rem;
            font-weight: 900;
            color: #fff;
        }

        .stat-dot.dot-b { background: #dc2626; }
        .stat-dot.dot-p { background: #2563eb; }
        .stat-dot.dot-t { background: #16a34a; }

        .stat-streak {
            font-size: 0.7rem;
            color: #ffd700;
            font-weight: 800;
            letter-spacing: 0.3px;
        }

        /* ===== COUNTDOWN BAR ===== */
        .countdown-bar {
            position: fixed;
            top: 0; left: 0;
            height: 3px;
            background: linear-gradient(90deg, #ffd700, #ff6b00);
            z-index: 9999;
            transition: width 0.3s linear;
            width: 100%;
        }

        /* ===== FOOTER ===== */
        footer {
            margin-top: 32px;
            padding: 24px;
            text-align: center;
            background: linear-gradient(135deg, #5c1010, #3a0808);
            border-radius: 14px;
            border: 1px solid rgba(255,215,0,0.15);
        }

        .footer-brand {
            font-size: 1.4rem;
            font-weight: 900;
            background: linear-gradient(to right, #ffd700, #ff8c00);
            -webkit-background-clip: text;
            -webkit-text-fill-color: transparent;
            background-clip: text;
        }

        .footer-time {
            font-family: 'Consolas', monospace;
            color: rgba(255,255,255,0.4);
            font-size: 0.8rem;
            margin-top: 4px;
        }

        .footer-copy {
            margin-top: 10px;
            font-size: 0.7rem;
            color: rgba(255,255,255,0.2);
        }

        /* ===== RESPONSIVE ===== */
        @media (max-width: 768px) {
            .container { padding: 8px; }
            .grid { grid-template-columns: repeat(2, 1fr); gap: 8px; }
            .bead { width: 13px; height: 13px; }
            .bead-T { width: 10px; height: 10px; margin: 1.5px; }
            .bead-empty { width: 13px; height: 13px; }
            .bead-area { min-height: 90px; padding: 6px; }
        }

        @media (max-width: 400px) {
            .grid { grid-template-columns: 1fr; }
        }
    </style>
</head>
<body>
    <div class="countdown-bar" id="countdownBar"></div>
    <div class="container">
        <div class="header">
            <h1>AE-SEXY BACCARAT</h1>
            <div class="header-info">
                <div class="info-item">
                    <div class="info-dot green"></div>
                    <span>Hệ thống hoạt động</span>
                </div>
                <div class="info-item">
                    <div class="info-dot gold"></div>
                    <span id="totalTablesText">0 bàn</span>
                </div>
                <div class="info-item">
                    <span id="liveClock">--:--:--</span>
                </div>
            </div>
        </div>

        <div class="controls">
            <a href="/api/baccarat" target="_blank" class="btn-api">📡 Xem API JSON</a>
        </div>

        <div id="sectionB"></div>
        <div id="sectionC"></div>

        <footer>
            <div class="footer-brand">Dwong1410</div>
            <div class="footer-time" id="footerClock">--:--:--</div>
            <div class="footer-copy">AE-SEXY Real-time Intelligence Engine &copy; 2026</div>
        </footer>
    </div>

    <script>
        // ===== ĐỒNG HỒ REALTIME =====
        function updateClock() {
            var now = new Date();
            var vnTime = now.toLocaleString("vi-VN", { timeZone: "Asia/Ho_Chi_Minh" });
            document.getElementById('liveClock').textContent = vnTime;
            document.getElementById('footerClock').textContent = 'Giờ VN: ' + vnTime;
        }
        updateClock();
        setInterval(updateClock, 1000);

        // ===== SẮP XẾP =====
        function sortTableNames(names) {
            return names.sort(function(a, b) {
                var aIsC = a.startsWith('C');
                var bIsC = b.startsWith('C');
                if (!aIsC && bIsC) return -1;
                if (aIsC && !bIsC) return 1;
                if (!aIsC && !bIsC) return parseInt(a) - parseInt(b);
                return parseInt(a.replace(/\\D/g,'')) - parseInt(b.replace(/\\D/g,''));
            });
        }

        // ===== THUẬT TOÁN ĐƯỜNG LỚN (BIG ROAD) =====
        function generateBigRoad(results) {
            var ROWS = 6;
            var matrix = {}; // key: "col,row" => { type: 'B'|'P', ties: 0 }
            var lastType = null;
            var lastCol = 0;
            var lastRow = 0;
            var colStart = 0;
            var maxCol = 0;

            if (!results) return { matrix: matrix, maxCol: 0 };

            var chars = results.split('');
            for (var i = 0; i < chars.length; i++) {
                var ch = chars[i];
                // Hòa: gạch chéo xanh lá đè lên kết quả trước đó, không chiếm ô và không đổi cột
                if (ch === 'T') {
                    if (lastType !== null) {
                        var key = lastCol + ',' + lastRow;
                        if (matrix[key]) {
                            matrix[key].ties = (matrix[key].ties || 0) + 1;
                        }
                    }
                    continue;
                }

                if (ch !== 'B' && ch !== 'P') continue;

                if (lastType === null) {
                    lastType = ch;
                    lastCol = 0;
                    lastRow = 0;
                    colStart = 0;
                    matrix['0,0'] = { type: ch, ties: 0 };
                    maxCol = 0;
                } else if (ch === lastType) {
                    // Cùng loại (Cái tiếp Cái, Con tiếp Con): đi dọc xuống ô dưới trong cùng cột
                    var nextRow = lastRow + 1;
                    var nextCol = lastCol;
                    // Nếu chạm đáy (vượt 6 hàng) hoặc ô bên dưới đã có hình -> bẻ sang phải (đuôi rồng)
                    if (nextRow >= ROWS || matrix[nextCol + ',' + nextRow]) {
                        nextCol = lastCol + 1;
                        nextRow = lastRow;
                    }
                    lastCol = nextCol;
                    lastRow = nextRow;
                    matrix[lastCol + ',' + lastRow] = { type: ch, ties: 0 };
                    if (lastCol > maxCol) maxCol = lastCol;
                } else {
                    // Đổi bên (từ Cái sang Con, hoặc từ Con sang Cái): chuyển sang cột bên cạnh từ hàng 0
                    lastType = ch;
                    colStart = colStart + 1;
                    while (matrix[colStart + ',0']) {
                        colStart++;
                    }
                    lastCol = colStart;
                    lastRow = 0;
                    matrix[lastCol + ',0'] = { type: ch, ties: 0 };
                    if (lastCol > maxCol) maxCol = lastCol;
                }
            }
            return { matrix: matrix, maxCol: maxCol };
        }

        // ===== XUẤT LƯỚI ĐƯỜNG LỚN 12 CỘT x 6 HÀNG =====
        // 2 cột cuối (cột 11 và 12, index 10 và 11) luôn để trống
        // Khi dữ liệu chạm đến cột 10 (index 9), tự động đẩy sang trái
        function buildBigRoadHtml(results, goodRoad) {
            var roadData = generateBigRoad(results);
            var matrix = roadData.matrix;
            var maxCol = roadData.maxCol;

            var VISIBLE_COLS = 12;
            var ROWS = 6;

            // Nếu maxCol >= 10, đẩy để cột maxCol nằm ở vị trí index 9, giữ 2 cột 10 và 11 luôn trống!
            var startCol = 0;
            if (maxCol >= 10) {
                startCol = maxCol - 9;
            }

            var cellsHtml = '';
            for (var c = 0; c < VISIBLE_COLS; c++) {
                var actualCol = startCol + c;
                for (var r = 0; r < ROWS; r++) {
                    var key = actualCol + ',' + r;
                    var cell = matrix[key];
                    var inner = '';
                    if (cell) {
                        var tieClass = '';
                        var tieHtml = '';
                        if (cell.ties === 1) {
                            tieClass = ' has-tie-single';
                        } else if (cell.ties >= 2) {
                            tieClass = ' has-tie-multi';
                            tieHtml = '<span class="tie-center-num">' + cell.ties + '</span>';
                        }
                        inner = '<div class="bead-ring bead-' + cell.type + tieClass + '">' + tieHtml + '</div>';
                    }
                    cellsHtml += '<div class="road-cell">' + inner + '</div>';
                }
            }

            var goodRoadHtml = goodRoad
                ? '<div class="good-road-ribbon">' + goodRoad + '</div>'
                : '';

            return '<div class="road-container">' +
                '<div class="road-grid">' + cellsHtml + '</div>' +
                goodRoadHtml +
            '</div>';
        }

        // ===== TẠO CARD HTML =====
        function buildCardHtml(id, data) {
            var results = data.results || "";
            var stats = data.stats || { p_count:0, t_count:0, b_count:0, total:0, longest_streak:"0", current_streak:"0" };
            var goodRoad = data.cau || "";
            var isC = id.startsWith('C');
            var label = isC ? 'Baccarat ' + id : 'Baccarat B' + id;

            var streakInfo = (stats.current_streak && stats.current_streak !== "0")
                ? stats.current_streak
                : "";

            return '<a href="/api/baccarat/' + id + '" class="card-link" target="_blank">' +
                '<div class="table-card">' +
                    '<div class="card-top">' +
                        '<div class="table-name">' +
                            '<span class="new-tag">NEW</span>' + label +
                        '</div>' +
                        '<div class="hand-status">Mở bài (' + stats.total + ')</div>' +
                    '</div>' +
                    buildBigRoadHtml(results, goodRoad) +
                    '<div class="card-bottom">' +
                        '<div class="stat-group">' +
                            '<div class="stat-pill"><span class="stat-dot dot-b">B</span> <span>' + stats.b_count + '</span></div>' +
                            '<div class="stat-pill"><span class="stat-dot dot-p">P</span> <span>' + stats.p_count + '</span></div>' +
                            '<div class="stat-pill"><span class="stat-dot dot-t">T</span> <span>' + stats.t_count + '</span></div>' +
                        '</div>' +
                        (streakInfo ? '<div class="stat-streak">🔥 ' + streakInfo + '</div>' : '') +
                    '</div>' +
                '</div>' +
            '</a>';
        }

        // ===== RENDER =====
        function renderDashboard(tableData) {
            var allNames = Object.keys(tableData);
            var sorted = sortTableNames(allNames);
            var bNames = sorted.filter(function(n) { return !n.startsWith('C'); });
            var cNames = sorted.filter(function(n) { return n.startsWith('C'); });

            document.getElementById('totalTablesText').textContent = sorted.length + ' bàn đang mở';

            // Section B
            var sB = document.getElementById('sectionB');
            if (bNames.length > 0) {
                var h = '<div class="section-header"><h2>🎲 Bàn B</h2><div class="divider"></div><span class="badge">' + bNames.length + ' bàn</span></div><div class="grid">';
                for (var i = 0; i < bNames.length; i++) {
                    h += buildCardHtml(bNames[i], tableData[bNames[i]]);
                }
                h += '</div>';
                sB.innerHTML = h;
            } else { sB.innerHTML = ''; }

            // Section C
            var sC = document.getElementById('sectionC');
            if (cNames.length > 0) {
                var h2 = '<div class="section-header"><h2>🎰 Bàn C</h2><div class="divider"></div><span class="badge">' + cNames.length + ' bàn</span></div><div class="grid">';
                for (var j = 0; j < cNames.length; j++) {
                    h2 += buildCardHtml(cNames[j], tableData[cNames[j]]);
                }
                h2 += '</div>';
                sC.innerHTML = h2;
            } else { sC.innerHTML = ''; }
        }

        // ===== FETCH & COUNTDOWN =====
        var REFRESH = 5;
        var countdown = REFRESH;

        function fetchData() {
            fetch('/api/baccarat')
                .then(function(r) { return r.json(); })
                .then(function(data) {
                    if (data && Object.keys(data).length > 0) {
                        renderDashboard(data);
                    }
                })
                .catch(function(e) { console.error('Fetch error:', e); });
        }

        function tick() {
            countdown--;
            if (countdown <= 0) {
                countdown = REFRESH;
                fetchData();
            }
            document.getElementById('countdownBar').style.width = ((countdown / REFRESH) * 100) + '%';
        }

        fetchData();
        setInterval(tick, 1000);
    </script>
</body>
</html>
    `);
});

app.listen(PORT, () => {
    console.log(`[🚀] Server AE-SEXY đang chạy tại port ${PORT}`);
    pollLoop();

    // Anti-shutdown (Self-ping)
    const RENDER_EXTERNAL_URL = process.env.RENDER_EXTERNAL_URL;
    if (RENDER_EXTERNAL_URL) {
        setInterval(() => {
            axios.get(RENDER_EXTERNAL_URL)
                .then(res => console.log(`[📡] Self-ping status: ${res.status}`))
                .catch(err => console.error('[⚠️] Self-ping error:', err.message));
        }, 5 * 60 * 1000);
    }
});
