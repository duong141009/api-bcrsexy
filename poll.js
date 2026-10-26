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

let TABLE_DATA = {}; // In-memory storage: { "7": { ... }, "C01": { ... } }

const httpsAgent = new https.Agent({
    keepAlive: true,
    keepAliveMsecs: 1000,
    timeout: 30000
});

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ================= HÀM SẮP XẾP BÀN =================
// Sắp xếp: bàn số (7,8,9,11...) từ nhỏ đến lớn, rồi bàn C (C01,C02...) từ nhỏ đến lớn
function sortTableNames(names) {
    return names.sort((a, b) => {
        const aIsC = a.startsWith('C');
        const bIsC = b.startsWith('C');

        // Bàn số luôn đứng trước bàn C
        if (!aIsC && bIsC) return -1;
        if (aIsC && !bIsC) return 1;

        // Cùng loại: so sánh theo số
        if (!aIsC && !bIsC) {
            return parseInt(a) - parseInt(b);
        }

        // Cùng bàn C: so sánh theo số sau C
        const aNum = parseInt(a.replace('C', ''));
        const bNum = parseInt(b.replace('C', ''));
        return aNum - bNum;
    });
}

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
                // Xóa dữ liệu cũ, chỉ giữ bàn có trong API mới nhất
                const newTableData = {};

                for (const table of json.data) {
                    const displayName = table.table_name; // Lấy trực tiếp từ API
                    const newResults = table.result || "";
                    const goodRoad = table.goodRoad || "";

                    // Tính toán thông số
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
    const sortedNames = sortTableNames(Object.keys(TABLE_DATA));
    const vnTime = new Date().toLocaleString("vi-VN", { timeZone: "Asia/Ho_Chi_Minh" });
    const totalTables = sortedNames.length;

    const tableListHtml = sortedNames.map((id, index) => {
        const data = TABLE_DATA[id];
        const results = data.results || "";
        const stats = data.stats || { p_count: 0, t_count: 0, b_count: 0, total: 0, longest_streak: "0", current_streak: "0" };
        const goodRoad = data.cau || "";

        const resultsHtml = results
            ? results.slice(-30).split('').map(c => `<span class="dot c-${c}">${c}</span>`).join('')
            : '<span class="loading">Đang chờ...</span>';

        const goodRoadHtml = goodRoad
            ? `<div class="good-road"><span class="road-icon">🔥</span>${goodRoad}</div>`
            : `<div class="good-road empty"><span class="road-icon">—</span>Chưa có cầu</div>`;

        const isC = id.startsWith('C');
        const typeClass = isC ? 'type-c' : 'type-num';
        const typeLabel = isC ? 'CLASSIC' : 'SPEED';

        return `
            <a href="/api/baccarat/${id}" class="card-link" target="_blank" style="animation-delay: ${index * 0.03}s">
                <div class="table-card ${typeClass}">
                    <div class="card-header">
                        <div class="header-left">
                            <span class="table-type-badge ${typeClass}">${typeLabel}</span>
                            <h3>${id}</h3>
                        </div>
                        <div class="header-right">
                            <span class="total-hands">${stats.total} ván</span>
                        </div>
                    </div>
                    ${goodRoadHtml}
                    <div class="stats-row">
                        <div class="stat-chip stat-p"><span class="stat-label">P</span><span class="stat-val">${stats.p_count}</span></div>
                        <div class="stat-chip stat-b"><span class="stat-label">B</span><span class="stat-val">${stats.b_count}</span></div>
                        <div class="stat-chip stat-t"><span class="stat-label">T</span><span class="stat-val">${stats.t_count}</span></div>
                    </div>
                    <div class="streak-row">
                        <div class="streak-item">
                            <span class="streak-label">Chuỗi dài nhất</span>
                            <span class="streak-val">${stats.longest_streak}</span>
                        </div>
                        <div class="streak-divider"></div>
                        <div class="streak-item">
                            <span class="streak-label">Chuỗi hiện tại</span>
                            <span class="streak-val">${stats.current_streak}</span>
                        </div>
                    </div>
                    <div class="results-row">${resultsHtml}</div>
                </div>
            </a>
        `;
    }).join('');

    res.send(`
        <!DOCTYPE html>
        <html lang="vi">
        <head>
            <title>AE-SEXY Baccarat — Live Dashboard</title>
            <meta name="viewport" content="width=device-width, initial-scale=1">
            <meta charset="UTF-8">
            <link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700;800;900&display=swap" rel="stylesheet">
            <style>
                *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

                :root {
                    --bg-primary: #0a0a1a;
                    --bg-card: rgba(18, 18, 40, 0.7);
                    --bg-card-hover: rgba(30, 30, 60, 0.9);
                    --border-card: rgba(255, 255, 255, 0.06);
                    --border-hover: rgba(139, 92, 246, 0.5);
                    --accent-1: #8b5cf6;
                    --accent-2: #06b6d4;
                    --accent-gradient: linear-gradient(135deg, #8b5cf6, #06b6d4);
                    --color-p: #3b82f6;
                    --color-b: #ef4444;
                    --color-t: #22c55e;
                    --text-primary: #f1f5f9;
                    --text-secondary: #94a3b8;
                    --text-muted: #475569;
                    --glass: rgba(255, 255, 255, 0.03);
                    --shadow-card: 0 4px 24px rgba(0,0,0,0.3);
                    --shadow-glow: 0 0 40px rgba(139, 92, 246, 0.1);
                }

                body {
                    font-family: 'Inter', -apple-system, BlinkMacSystemFont, sans-serif;
                    background: var(--bg-primary);
                    color: var(--text-primary);
                    min-height: 100vh;
                    overflow-x: hidden;
                }

                /* Animated background */
                body::before {
                    content: '';
                    position: fixed;
                    top: 0; left: 0; right: 0; bottom: 0;
                    background:
                        radial-gradient(ellipse 80% 50% at 20% 40%, rgba(139, 92, 246, 0.08) 0%, transparent 50%),
                        radial-gradient(ellipse 60% 40% at 80% 60%, rgba(6, 182, 212, 0.06) 0%, transparent 50%),
                        radial-gradient(ellipse 40% 30% at 50% 90%, rgba(59, 130, 246, 0.05) 0%, transparent 50%);
                    pointer-events: none;
                    z-index: 0;
                }

                .container {
                    max-width: 1400px;
                    margin: 0 auto;
                    padding: 20px;
                    position: relative;
                    z-index: 1;
                }

                /* ========= HEADER ========= */
                .header-section {
                    text-align: center;
                    padding: 48px 24px 36px;
                    margin-bottom: 32px;
                    background: var(--glass);
                    backdrop-filter: blur(20px);
                    border-radius: 28px;
                    border: 1px solid var(--border-card);
                    position: relative;
                    overflow: hidden;
                }

                .header-section::before {
                    content: '';
                    position: absolute;
                    top: 0; left: 0; right: 0;
                    height: 2px;
                    background: var(--accent-gradient);
                }

                .logo-text {
                    font-size: clamp(2rem, 5vw, 3.5rem);
                    font-weight: 900;
                    letter-spacing: -2px;
                    background: var(--accent-gradient);
                    -webkit-background-clip: text;
                    -webkit-text-fill-color: transparent;
                    background-clip: text;
                    line-height: 1.1;
                    margin-bottom: 12px;
                }

                .header-subtitle {
                    font-size: 0.95rem;
                    color: var(--text-secondary);
                    font-weight: 400;
                    margin-bottom: 20px;
                }

                .header-stats {
                    display: flex;
                    justify-content: center;
                    gap: 24px;
                    flex-wrap: wrap;
                }

                .header-stat {
                    display: flex;
                    align-items: center;
                    gap: 8px;
                    padding: 8px 18px;
                    background: rgba(255,255,255,0.04);
                    border-radius: 100px;
                    border: 1px solid rgba(255,255,255,0.06);
                    font-size: 0.85rem;
                }

                .header-stat .dot-indicator {
                    width: 8px; height: 8px;
                    border-radius: 50%;
                    animation: blink 2s infinite;
                }

                .dot-green { background: var(--color-t); }
                .dot-purple { background: var(--accent-1); }

                @keyframes blink {
                    0%, 100% { opacity: 1; }
                    50% { opacity: 0.3; }
                }

                @keyframes fadeInUp {
                    from { opacity: 0; transform: translateY(20px); }
                    to { opacity: 1; transform: translateY(0); }
                }

                /* ========= SECTION DIVIDER ========= */
                .section-title {
                    display: flex;
                    align-items: center;
                    gap: 12px;
                    margin: 32px 0 20px;
                    padding: 0 4px;
                }

                .section-title h2 {
                    font-size: 1.1rem;
                    font-weight: 700;
                    color: var(--text-primary);
                    white-space: nowrap;
                }

                .section-title .line {
                    flex: 1;
                    height: 1px;
                    background: linear-gradient(to right, var(--border-card), transparent);
                }

                .section-title .count-badge {
                    background: rgba(139, 92, 246, 0.15);
                    color: var(--accent-1);
                    padding: 4px 12px;
                    border-radius: 100px;
                    font-size: 0.75rem;
                    font-weight: 700;
                }

                /* ========= TABLE GRID ========= */
                .grid {
                    display: grid;
                    grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
                    gap: 16px;
                }

                .card-link {
                    text-decoration: none;
                    color: inherit;
                    display: block;
                    animation: fadeInUp 0.5s ease both;
                }

                .table-card {
                    background: var(--bg-card);
                    backdrop-filter: blur(12px);
                    padding: 20px;
                    border-radius: 20px;
                    border: 1px solid var(--border-card);
                    transition: all 0.35s cubic-bezier(0.4, 0, 0.2, 1);
                    position: relative;
                    overflow: hidden;
                }

                .table-card::before {
                    content: '';
                    position: absolute;
                    top: 0; left: 0; right: 0;
                    height: 3px;
                    opacity: 0;
                    transition: opacity 0.35s;
                }

                .table-card.type-num::before { background: linear-gradient(90deg, #f59e0b, #ef4444); }
                .table-card.type-c::before { background: linear-gradient(90deg, #8b5cf6, #06b6d4); }

                .card-link:hover .table-card {
                    background: var(--bg-card-hover);
                    border-color: var(--border-hover);
                    transform: translateY(-4px);
                    box-shadow: var(--shadow-card), var(--shadow-glow);
                }

                .card-link:hover .table-card::before {
                    opacity: 1;
                }

                /* Card Header */
                .card-header {
                    display: flex;
                    justify-content: space-between;
                    align-items: center;
                    margin-bottom: 12px;
                }

                .header-left {
                    display: flex;
                    align-items: center;
                    gap: 10px;
                }

                .table-type-badge {
                    font-size: 0.6rem;
                    font-weight: 800;
                    padding: 3px 8px;
                    border-radius: 6px;
                    letter-spacing: 1px;
                    text-transform: uppercase;
                }

                .table-type-badge.type-num {
                    background: rgba(245, 158, 11, 0.15);
                    color: #f59e0b;
                    border: 1px solid rgba(245, 158, 11, 0.25);
                }

                .table-type-badge.type-c {
                    background: rgba(139, 92, 246, 0.15);
                    color: #a78bfa;
                    border: 1px solid rgba(139, 92, 246, 0.25);
                }

                .card-header h3 {
                    font-size: 1.4rem;
                    font-weight: 800;
                    color: var(--text-primary);
                    letter-spacing: -0.5px;
                }

                .total-hands {
                    font-size: 0.75rem;
                    color: var(--text-muted);
                    font-weight: 500;
                }

                /* Good Road */
                .good-road {
                    display: flex;
                    align-items: center;
                    gap: 6px;
                    padding: 8px 12px;
                    border-radius: 10px;
                    font-size: 0.8rem;
                    font-weight: 600;
                    margin-bottom: 14px;
                    background: rgba(234, 179, 8, 0.08);
                    color: #fbbf24;
                    border: 1px solid rgba(234, 179, 8, 0.15);
                }

                .good-road.empty {
                    background: rgba(255,255,255,0.02);
                    color: var(--text-muted);
                    border-color: transparent;
                    font-weight: 400;
                }

                .road-icon { font-size: 0.9rem; }

                /* Stats Row */
                .stats-row {
                    display: flex;
                    gap: 8px;
                    margin-bottom: 12px;
                }

                .stat-chip {
                    flex: 1;
                    display: flex;
                    align-items: center;
                    justify-content: space-between;
                    padding: 8px 12px;
                    border-radius: 10px;
                    font-size: 0.85rem;
                }

                .stat-p {
                    background: rgba(59, 130, 246, 0.1);
                    border: 1px solid rgba(59, 130, 246, 0.15);
                }
                .stat-b {
                    background: rgba(239, 68, 68, 0.1);
                    border: 1px solid rgba(239, 68, 68, 0.15);
                }
                .stat-t {
                    background: rgba(34, 197, 94, 0.1);
                    border: 1px solid rgba(34, 197, 94, 0.15);
                }

                .stat-label {
                    font-weight: 800;
                    font-size: 0.75rem;
                }
                .stat-p .stat-label { color: var(--color-p); }
                .stat-b .stat-label { color: var(--color-b); }
                .stat-t .stat-label { color: var(--color-t); }

                .stat-val {
                    font-weight: 700;
                    color: var(--text-primary);
                }

                /* Streak Row */
                .streak-row {
                    display: flex;
                    align-items: center;
                    gap: 0;
                    margin-bottom: 14px;
                    background: rgba(0,0,0,0.2);
                    border-radius: 10px;
                    padding: 8px 0;
                }

                .streak-item {
                    flex: 1;
                    text-align: center;
                }

                .streak-label {
                    display: block;
                    font-size: 0.65rem;
                    color: var(--text-muted);
                    font-weight: 500;
                    margin-bottom: 2px;
                    text-transform: uppercase;
                    letter-spacing: 0.5px;
                }

                .streak-val {
                    font-size: 1rem;
                    font-weight: 800;
                    color: var(--accent-2);
                }

                .streak-divider {
                    width: 1px;
                    height: 28px;
                    background: rgba(255,255,255,0.08);
                }

                /* Results Row */
                .results-row {
                    display: flex;
                    flex-wrap: wrap;
                    gap: 3px;
                    min-height: 26px;
                    align-items: center;
                }

                .dot {
                    width: 22px;
                    height: 22px;
                    display: inline-flex;
                    align-items: center;
                    justify-content: center;
                    border-radius: 50%;
                    font-size: 0.55rem;
                    font-weight: 800;
                    color: white;
                    flex-shrink: 0;
                }

                .c-B { background: var(--color-b); box-shadow: 0 2px 8px rgba(239, 68, 68, 0.3); }
                .c-P { background: var(--color-p); box-shadow: 0 2px 8px rgba(59, 130, 246, 0.3); }
                .c-T { background: var(--color-t); box-shadow: 0 2px 8px rgba(34, 197, 94, 0.3); }

                .loading {
                    font-size: 0.75rem;
                    color: var(--text-muted);
                    font-style: italic;
                }

                /* ========= FOOTER ========= */
                footer {
                    margin-top: 48px;
                    padding: 36px 24px;
                    text-align: center;
                    background: var(--glass);
                    backdrop-filter: blur(12px);
                    border-radius: 24px;
                    border: 1px solid var(--border-card);
                }

                .footer-brand {
                    font-size: 1.6rem;
                    font-weight: 900;
                    background: var(--accent-gradient);
                    -webkit-background-clip: text;
                    -webkit-text-fill-color: transparent;
                    background-clip: text;
                    margin-bottom: 6px;
                }

                .footer-time {
                    font-family: 'SF Mono', 'Monaco', 'Consolas', monospace;
                    color: var(--text-muted);
                    font-size: 0.85rem;
                }

                .footer-copy {
                    margin-top: 16px;
                    font-size: 0.75rem;
                    color: var(--text-muted);
                    opacity: 0.5;
                }

                /* ========= RESPONSIVE ========= */
                @media (max-width: 768px) {
                    .container { padding: 12px; }
                    .header-section { padding: 32px 16px 24px; border-radius: 20px; }
                    .grid { grid-template-columns: 1fr 1fr; gap: 10px; }
                    .table-card { padding: 14px; border-radius: 16px; }
                    .card-header h3 { font-size: 1.1rem; }
                    .stat-chip { padding: 6px 8px; }
                    .dot { width: 18px; height: 18px; font-size: 0.5rem; }
                    .header-stats { gap: 10px; }
                }

                @media (max-width: 480px) {
                    .grid { grid-template-columns: 1fr; }
                }

                /* Auto refresh indicator */
                .refresh-bar {
                    position: fixed;
                    top: 0; left: 0;
                    height: 3px;
                    background: var(--accent-gradient);
                    z-index: 9999;
                    animation: refreshProgress 15s linear infinite;
                }

                @keyframes refreshProgress {
                    from { width: 100%; }
                    to { width: 0%; }
                }
            </style>
        </head>
        <body>
            <div class="refresh-bar"></div>
            <div class="container">
                <div class="header-section">
                    <div class="logo-text">AE-SEXY BACCARAT</div>
                    <p class="header-subtitle">Real-time Baccarat Intelligence Dashboard</p>
                    <div class="header-stats">
                        <div class="header-stat">
                            <div class="dot-indicator dot-green"></div>
                            <span>Hệ thống hoạt động</span>
                        </div>
                        <div class="header-stat">
                            <div class="dot-indicator dot-purple"></div>
                            <span>${totalTables} bàn đang mở</span>
                        </div>
                        <div class="header-stat">
                            <span>🕐 ${vnTime}</span>
                        </div>
                    </div>
                </div>

                <div class="main-controls" style="display:flex;justify-content:center;gap:12px;margin-bottom:24px;">
                    <a href="/api/baccarat" target="_blank" style="
                        display:inline-flex;align-items:center;gap:8px;
                        padding:12px 28px;border-radius:14px;
                        background:var(--accent-gradient);color:white;
                        text-decoration:none;font-weight:700;font-size:0.9rem;
                        box-shadow:0 4px 20px rgba(139,92,246,0.3);
                        transition:all 0.3s ease;
                    ">📡 Xem API JSON</a>
                </div>

                ${sortedNames.filter(n => !n.startsWith('C')).length > 0 ? `
                <div class="section-title">
                    <h2>⚡ Bàn Speed</h2>
                    <div class="line"></div>
                    <span class="count-badge">${sortedNames.filter(n => !n.startsWith('C')).length} bàn</span>
                </div>
                <div class="grid">
                    ${sortedNames.filter(n => !n.startsWith('C')).map((id, index) => {
                        const data = TABLE_DATA[id];
                        const results = data.results || "";
                        const stats = data.stats;
                        const goodRoad = data.cau || "";
                        const resultsHtml = results
                            ? results.slice(-30).split('').map(c => `<span class="dot c-${c}">${c}</span>`).join('')
                            : '<span class="loading">Đang chờ...</span>';
                        const goodRoadHtml = goodRoad
                            ? `<div class="good-road"><span class="road-icon">🔥</span>${goodRoad}</div>`
                            : `<div class="good-road empty"><span class="road-icon">—</span>Chưa có cầu</div>`;
                        return `
                            <a href="/api/baccarat/${id}" class="card-link" target="_blank" style="animation-delay: ${index * 0.03}s">
                                <div class="table-card type-num">
                                    <div class="card-header">
                                        <div class="header-left">
                                            <span class="table-type-badge type-num">SPEED</span>
                                            <h3>${id}</h3>
                                        </div>
                                        <div class="header-right">
                                            <span class="total-hands">${stats.total} ván</span>
                                        </div>
                                    </div>
                                    ${goodRoadHtml}
                                    <div class="stats-row">
                                        <div class="stat-chip stat-p"><span class="stat-label">P</span><span class="stat-val">${stats.p_count}</span></div>
                                        <div class="stat-chip stat-b"><span class="stat-label">B</span><span class="stat-val">${stats.b_count}</span></div>
                                        <div class="stat-chip stat-t"><span class="stat-label">T</span><span class="stat-val">${stats.t_count}</span></div>
                                    </div>
                                    <div class="streak-row">
                                        <div class="streak-item">
                                            <span class="streak-label">Chuỗi dài nhất</span>
                                            <span class="streak-val">${stats.longest_streak}</span>
                                        </div>
                                        <div class="streak-divider"></div>
                                        <div class="streak-item">
                                            <span class="streak-label">Chuỗi hiện tại</span>
                                            <span class="streak-val">${stats.current_streak}</span>
                                        </div>
                                    </div>
                                    <div class="results-row">${resultsHtml}</div>
                                </div>
                            </a>
                        `;
                    }).join('')}
                </div>
                ` : ''}

                ${sortedNames.filter(n => n.startsWith('C')).length > 0 ? `
                <div class="section-title">
                    <h2>🎰 Bàn Classic</h2>
                    <div class="line"></div>
                    <span class="count-badge">${sortedNames.filter(n => n.startsWith('C')).length} bàn</span>
                </div>
                <div class="grid">
                    ${sortedNames.filter(n => n.startsWith('C')).map((id, index) => {
                        const data = TABLE_DATA[id];
                        const results = data.results || "";
                        const stats = data.stats;
                        const goodRoad = data.cau || "";
                        const resultsHtml = results
                            ? results.slice(-30).split('').map(c => `<span class="dot c-${c}">${c}</span>`).join('')
                            : '<span class="loading">Đang chờ...</span>';
                        const goodRoadHtml = goodRoad
                            ? `<div class="good-road"><span class="road-icon">🔥</span>${goodRoad}</div>`
                            : `<div class="good-road empty"><span class="road-icon">—</span>Chưa có cầu</div>`;
                        return `
                            <a href="/api/baccarat/${id}" class="card-link" target="_blank" style="animation-delay: ${index * 0.03}s">
                                <div class="table-card type-c">
                                    <div class="card-header">
                                        <div class="header-left">
                                            <span class="table-type-badge type-c">CLASSIC</span>
                                            <h3>${id}</h3>
                                        </div>
                                        <div class="header-right">
                                            <span class="total-hands">${stats.total} ván</span>
                                        </div>
                                    </div>
                                    ${goodRoadHtml}
                                    <div class="stats-row">
                                        <div class="stat-chip stat-p"><span class="stat-label">P</span><span class="stat-val">${stats.p_count}</span></div>
                                        <div class="stat-chip stat-b"><span class="stat-label">B</span><span class="stat-val">${stats.b_count}</span></div>
                                        <div class="stat-chip stat-t"><span class="stat-label">T</span><span class="stat-val">${stats.t_count}</span></div>
                                    </div>
                                    <div class="streak-row">
                                        <div class="streak-item">
                                            <span class="streak-label">Chuỗi dài nhất</span>
                                            <span class="streak-val">${stats.longest_streak}</span>
                                        </div>
                                        <div class="streak-divider"></div>
                                        <div class="streak-item">
                                            <span class="streak-label">Chuỗi hiện tại</span>
                                            <span class="streak-val">${stats.current_streak}</span>
                                        </div>
                                    </div>
                                    <div class="results-row">${resultsHtml}</div>
                                </div>
                            </a>
                        `;
                    }).join('')}
                </div>
                ` : ''}

                <footer>
                    <div class="footer-brand">Dwong1410</div>
                    <div class="footer-time">Giờ Việt Nam: ${vnTime}</div>
                    <div class="footer-copy">AE-SEXY Real-time Intelligence Engine &copy; 2026 — Auto Refresh 15s</div>
                </footer>
            </div>

            <script>
                // Auto refresh mượt mà bằng fetch thay vì reload toàn trang
                setTimeout(() => { location.reload(); }, 15000);
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
        }, 5 * 60 * 1000); // 5 minutes
    }
});
