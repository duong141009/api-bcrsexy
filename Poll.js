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

const BCR_URL = "https://toolbcr88.com/baccarat/getnewresult";
const PORT = process.env.PORT || 5000;

// Nếu true: các bàn chỉ có số trong JSON ("6", "15") sẽ hiển thị thành "B06", "B15"
// Nếu false: giữ nguyên tên gốc từ JSON ("6", "15")
const ADD_B_PREFIX_FOR_NUMBER_TABLES = true;

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

let TABLE_DATA = {}; // In-memory storage: chỉ lưu các bàn đang có dữ liệu theo thứ tự C -> B

const httpsAgent = new https.Agent({
    keepAlive: true,
    keepAliveMsecs: 1000,
    timeout: 30000
});

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ================= HÀM CHUẨN HÓA & SẮP XẾP TÊN BÀN =================
function formatTableName(rawName) {
    if (!rawName) return "";
    const name = String(rawName).trim().toUpperCase();
    if (/^\d+$/.test(name)) {
        return ADD_B_PREFIX_FOR_NUMBER_TABLES ? `B${name.padStart(2, '0')}` : name;
    }
    const match = name.match(/^([A-Z]+)(\d+)$/);
    if (match) {
        return `${match[1]}${match[2].padStart(2, '0')}`;
    }
    return name;
}

function getSortMeta(tableName) {
    const name = String(tableName).trim().toUpperCase();
    const match = name.match(/^([A-Z]*)(\d+)$/);
    if (match) {
        const prefix = match[1];
        const num = parseInt(match[2], 10);
        // Ưu tiên bàn C đứng trước (group 0), tiếp theo là bàn B / bàn số (group 1), còn lại (group 2)
        let group = 2;
        if (prefix === 'C') group = 0;
        else if (prefix === 'B' || prefix === '') group = 1;
        return { group, num, name };
    }
    return { group: 3, num: 0, name };
}

function compareTableNames(a, b) {
    const metaA = getSortMeta(a);
    const metaB = getSortMeta(b);
    if (metaA.group !== metaB.group) return metaA.group - metaB.group;
    if (metaA.num !== metaB.num) return metaA.num - metaB.num;
    return metaA.name.localeCompare(metaB.name);
}

function computeStats(newResults) {
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

    return {
        p_count: pCount,
        t_count: tCount,
        b_count: bCount,
        longest_streak: `${maxStreak}${longestStreakChar}`,
        current_streak: `${currentStreakCount}${currentStreakChar}`
    };
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
        // Thêm redirect: 'manual' để tránh fetch tự động theo link redirect tới trang login
        const res = await fetch(url, { ...options, agent: httpsAgent, redirect: 'manual' });

        // Nhận diện mã lỗi liên quan đến xác thực hoặc redirect
        if (res.status === 401 || res.status === 419 || res.status === 301 || res.status === 302) {
            console.log(`\n⚠️ Token hết hạn hoặc bị chuyển hướng (${res.status}). Đang tự động Login lại...`);
            await autoLoginAndGetHeaders();
            return fetchWithRetry(url, options, retries);
        }

        // Bắt trường hợp bị chuyển hướng nhưng status vẫn 200
        if (res.url && res.url.includes('/login')) {
            console.log("\n⚠️ Bị chuyển hướng tới trang đăng nhập. Đang tự động Login lại...");
            await autoLoginAndGetHeaders();
            return fetchWithRetry(url, options, retries);
        }

        if (!res.ok) throw new Error(`HTTP Error: ${res.status}`);
        
        // Đảm bảo dữ liệu trả về không phải là HTML của trang báo lỗi/login
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

            if (Array.isArray(json?.data)) {
                let updated = 0;
                const tempMap = {};

                for (const table of json.data) {
                    const displayName = formatTableName(table.table_name);
                    const newResults = (table.result || "").trim();

                    // Chỉ lấy những bàn đang có dữ liệu kết quả
                    if (!displayName || !newResults) continue;

                    const vnTime = new Date().toLocaleString("vi-VN", { timeZone: "Asia/Ho_Chi_Minh" });

                    if (!TABLE_DATA[displayName] || TABLE_DATA[displayName].results !== newResults) {
                        tempMap[displayName] = {
                            cau: "",
                            results: newResults,
                            time: vnTime,
                            stats: computeStats(newResults)
                        };
                        updated++;
                    } else {
                        tempMap[displayName] = TABLE_DATA[displayName];
                    }
                }

                // Sắp xếp lại thứ tự bàn: C01 -> C... rồi đến B01 -> B...
                const sortedKeys = Object.keys(tempMap).sort(compareTableNames);
                const sortedTableData = {};
                for (const key of sortedKeys) {
                    sortedTableData[key] = tempMap[key];
                }
                TABLE_DATA = sortedTableData;

                if (updated > 0) {
                    console.log(`[📡] Cập nhật: ${updated} bàn mới (Tổng bàn có dữ liệu: ${sortedKeys.length}).`);
                }
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

// API: Lấy tất cả dữ liệu bàn (đã được lọc bàn có dữ liệu và sắp xếp C -> B)
app.get('/api/baccarat', (req, res) => {
    res.json(TABLE_DATA);
});

// API: Lấy dữ liệu 1 bàn cụ thể (hỗ trợ cả tên chuẩn hóa như B06, C01 lẫn tên gốc 6, C1)
app.get('/api/baccarat/:tableName', (req, res) => {
    const rawParam = req.params.tableName.toUpperCase();
    const formattedParam = formatTableName(rawParam);

    if (TABLE_DATA[formattedParam]) {
        res.json(TABLE_DATA[formattedParam]);
    } else if (TABLE_DATA[rawParam]) {
        res.json(TABLE_DATA[rawParam]);
    } else {
        res.status(404).json({ cau: "", results: "" });
    }
});

// Landing Page Dashboard
app.get('/', (req, res) => {
    const activeTableIds = Object.keys(TABLE_DATA).sort(compareTableNames);

    const tableListHtml = activeTableIds.length > 0
        ? activeTableIds.map(id => {
            const data = TABLE_DATA[id];
            const results = data.results || "";
            const stats = data.stats || { p_count: 0, t_count: 0, b_count: 0, longest_streak: "0", current_streak: "0" };

            const resultsHtml = results
                .slice(-20)
                .split('')
                .map(c => `<span class="c-${c}">${c}</span>`)
                .join('');

            return `
                <a href="/api/baccarat/${id}" class="card-link" target="_blank">
                    <div class="table-card">
                        <div class="card-header">
                            <h3>Table ${id}</h3>
                            <span class="btn-api-small">API</span>
                        </div>
                        <div class="stats-grid">
                            <div class="stat-item"><span class="label">P:</span> <span class="val color-P">${stats.p_count}</span></div>
                            <div class="stat-item"><span class="label">T:</span> <span class="val color-T">${stats.t_count}</span></div>
                            <div class="stat-item"><span class="label">B:</span> <span class="val color-B">${stats.b_count}</span></div>
                        </div>
                        <div class="streak-info">
                            <div>Dài nhất: <span class="val">${stats.longest_streak}</span></div>
                            <div>Gần nhất: <span class="val">${stats.current_streak}</span></div>
                        </div>
                        <div class="results">${resultsHtml}</div>
                    </div>
                </a>
            `;
        }).join('')
        : '<div class="loading">Đang chờ dữ liệu bàn từ hệ thống...</div>';

    const vnTime = new Date().toLocaleString("vi-VN", { timeZone: "Asia/Ho_Chi_Minh" });

    res.send(`
        <!DOCTYPE html>
        <html>
        <head>
            <title>AE-SEXY Baccarat API - Premium Dashboard</title>
            <meta name="viewport" content="width=device-width, initial-scale=1">
            <style>
                @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;600;800&display=swap');
                
                body { 
                    font-family: 'Inter', sans-serif; 
                    background: #080810; 
                    color: #fff; 
                    margin: 0; 
                    padding: 20px; 
                    background-image: radial-gradient(circle at 50% 50%, #1a1a2e 0%, #080810 100%);
                    min-height: 100vh;
                }
                .container { max-width: 1200px; margin: 0 auto; }
                
                header { 
                    text-align: center;
                    margin-bottom: 40px; 
                    padding: 40px 20px; 
                    background: rgba(255, 255, 255, 0.03);
                    backdrop-filter: blur(10px);
                    border-radius: 24px; 
                    border: 1px solid rgba(255, 255, 255, 0.1);
                    box-shadow: 0 10px 40px rgba(0,0,0,0.5); 
                }
                
                h1 { 
                    margin: 0; 
                    font-size: 3em; 
                    font-weight: 800;
                    letter-spacing: -1px;
                    background: linear-gradient(to right, #6e45e2, #88d3ce);
                    -webkit-background-clip: text;
                    -webkit-text-fill-color: transparent;
                }
                
                .status-badge { 
                    display: inline-block; 
                    padding: 6px 16px; 
                    background: rgba(40, 167, 69, 0.15); 
                    color: #28a745;
                    border: 1px solid #28a745;
                    border-radius: 30px; 
                    font-size: 0.85em; 
                    margin-top: 15px; 
                    font-weight: 600;
                    animation: pulse 2s infinite;
                }
                
                @keyframes pulse {
                    0% { box-shadow: 0 0 0 0 rgba(40, 167, 69, 0.4); }
                    70% { box-shadow: 0 0 0 10px rgba(40, 167, 69, 0); }
                    100% { box-shadow: 0 0 0 0 rgba(40, 167, 69, 0); }
                }

                .main-controls {
                    display: flex;
                    justify-content: center;
                    gap: 15px;
                    margin-bottom: 30px;
                }

                .btn-primary {
                    background: linear-gradient(135deg, #6e45e2 0%, #4a32b1 100%);
                    color: white;
                    padding: 12px 28px;
                    border-radius: 12px;
                    text-decoration: none;
                    font-weight: 600;
                    transition: all 0.3s ease;
                    border: none;
                    box-shadow: 0 4px 15px rgba(110, 69, 226, 0.3);
                }
                
                .btn-primary:hover {
                    transform: translateY(-2px);
                    box-shadow: 0 6px 20px rgba(110, 69, 226, 0.5);
                }

                .grid { 
                    display: grid; 
                    grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); 
                    gap: 20px; 
                }
                
                .card-link {
                    text-decoration: none;
                    color: inherit;
                    display: block;
                    transition: transform 0.3s ease;
                }

                .card-link:hover .table-card {
                    transform: scale(1.02);
                    border-color: rgba(110, 69, 226, 0.4);
                    background: rgba(40, 40, 60, 0.8);
                }

                .table-card { 
                    background: rgba(30, 30, 47, 0.6); 
                    padding: 20px; 
                    border-radius: 20px; 
                    border: 1px solid rgba(255, 255, 255, 0.05);
                    height: 100%;
                }
                
                .card-header {
                    display: flex;
                    justify-content: space-between;
                    align-items: center;
                    margin-bottom: 15px;
                }
                
                .card-header h3 { margin: 0; font-size: 1.2em; color: #88d3ce; }

                .stats-grid {
                    display: flex;
                    justify-content: space-around;
                    background: rgba(0,0,0,0.2);
                    padding: 8px;
                    border-radius: 10px;
                    margin-bottom: 10px;
                    font-size: 0.9em;
                }
                .label { opacity: 0.6; }
                .val { font-weight: 800; }
                
                .streak-info {
                    display: flex;
                    justify-content: space-between;
                    font-size: 0.8em;
                    margin-bottom: 12px;
                    opacity: 0.8;
                }

                .color-P { color: #2196f3; }
                .color-T { color: #4caf50; }
                .color-B { color: #f44336; }

                .btn-api-small {
                    background: rgba(255, 255, 255, 0.05);
                    color: #aaa;
                    padding: 4px 10px;
                    border-radius: 6px;
                    font-size: 0.75em;
                    text-decoration: none;
                    border: 1px solid rgba(255, 255, 255, 0.1);
                }

                .results { 
                    font-family: 'Monaco', 'Consolas', monospace; 
                    font-size: 1.2em; 
                    display: flex;
                    flex-wrap: wrap;
                    gap: 3px;
                    min-height: 40px;
                }
                
                .loading { font-size: 0.9em; color: #888; font-style: italic; text-align: center; grid-column: 1 / -1; padding: 40px 0; }

                .c-B { background: #f44336; color: white; width: 18px; height: 18px; display: flex; align-items: center; justify-content: center; border-radius: 50%; font-size: 0.55em; font-weight: 800; }
                .c-P { background: #2196f3; color: white; width: 18px; height: 18px; display: flex; align-items: center; justify-content: center; border-radius: 50%; font-size: 0.55em; font-weight: 800; }
                .c-T { background: #4caf50; color: white; width: 18px; height: 18px; display: flex; align-items: center; justify-content: center; border-radius: 50%; font-size: 0.55em; font-weight: 800; }
                
                footer { 
                    margin-top: 60px; 
                    padding: 40px 20px;
                    text-align: center;
                    background: rgba(255, 255, 255, 0.02);
                    border-radius: 20px;
                    border-top: 1px solid rgba(255, 255, 255, 0.05);
                }
                .footer-id { font-size: 1.5em; font-weight: 800; color: #88d3ce; margin-bottom: 5px; }
                .footer-time { font-family: monospace; opacity: 0.6; }
                
                /* Responsive */
                @media (max-width: 600px) {
                    h1 { font-size: 2em; }
                    .grid { grid-template-columns: 1fr; }
                }
            </style>
            <meta http-equiv="refresh" content="30">
        </head>
        <body>
            <div class="container">
                <header>
                    <h1>AE-SEXY Baccarat API</h1>
                    <div class="status-badge">SYSTEM OPERATIONAL</div>
                </header>
                
                <div class="main-controls">
                    <a href="/api/baccarat" class="btn-primary" target="_blank">View All API Data</a>
                </div>

                <div class="grid">
                    ${tableListHtml}
                </div>
                
                <footer>
                    <div class="footer-id">ID: Dwong1410</div>
                    <div class="footer-time">Giờ Việt Nam: ${vnTime}</div>
                    <div style="margin-top: 15px; opacity: 0.3; font-size: 0.8em;">AE-SEXY Real-time Intelligence Engine &copy; 2026</div>
                </footer>
            </div>
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