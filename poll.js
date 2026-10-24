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

const BCR_URL ="https://toolbcr88.com/baccarat/getnewresult"
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
                for (const table of json.data) {
                    let displayName = String(table.table_name).trim().toUpperCase();
                    
                    if (/^\d+$/.test(displayName)) {
                        displayName = 'B' + displayName.padStart(2, '0');
                    }

                    if (displayName) {
                        const newResults = table.result || "";
                        if (!TABLE_DATA[displayName] || TABLE_DATA[displayName].results !== newResults) {

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

                            TABLE_DATA[displayName] = {
                                cau: table.goodRoad || "",
                                results: newResults,
                                time: vnTime,
                                stats: {
                                    p_count: pCount,
                                    t_count: tCount,
                                    b_count: bCount,
                                    longest_streak: `${maxStreak}${longestStreakChar}`,
                                    current_streak: `${currentStreakCount}${currentStreakChar}`
                                }
                            };
                            updated++;
                        }
                    }
                }
                if (updated > 0) console.log(`[📡] Cập nhật: ${updated} bàn mới.`);
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

// Landing Page Dashboard (GIAO DIỆN MỚI 2026)
app.get('/', (req, res) => {
    const currentTableIds = Object.keys(TABLE_DATA).sort((a, b) => {
        const aIsC = a.startsWith('C');
        const bIsC = b.startsWith('C');
        
        if (aIsC && !bIsC) return -1; 
        if (!aIsC && bIsC) return 1;  
        
        return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
    });

    const tableListHtml = currentTableIds.map(id => {
        const data = TABLE_DATA[id];
        const results = data.results || "";
        const stats = data.stats || { p_count: 0, t_count: 0, b_count: 0, longest_streak: "0", current_streak: "0" };
        const goodRoad = data.cau ? `<div class="good-road-badge"><i class="icon-star"></i> ${data.cau}</div>` : '';

        // Hiển thị tối đa 26 hạt gần nhất cho đỡ chật
        const resultsHtml = results
            ? results.slice(-26).split('').map(c => `<span class="bead c-${c}">${c}</span>`).join('')
            : '<span class="loading">Đang chờ tín hiệu vệ tinh...</span>';

        return `
            <a href="/api/baccarat/${id}" class="card-link" target="_blank">
                <div class="table-card">
                    <div class="card-header">
                        <div class="table-title">
                            <span class="table-icon">♠</span> TABLE ${id}
                        </div>
                        ${goodRoad}
                    </div>
                    <div class="stats-grid">
                        <div class="stat-item"><span class="label">PLAYER</span> <span class="val color-P">${stats.p_count}</span></div>
                        <div class="stat-item"><span class="label">TIE</span> <span class="val color-T">${stats.t_count}</span></div>
                        <div class="stat-item"><span class="label">BANKER</span> <span class="val color-B">${stats.b_count}</span></div>
                    </div>
                    <div class="streak-info">
                        <div class="streak-box">
                            <span class="s-label">Dài nhất</span>
                            <span class="s-val">${stats.longest_streak}</span>
                        </div>
                        <div class="streak-box">
                            <span class="s-label">Gần nhất</span>
                            <span class="s-val">${stats.current_streak}</span>
                        </div>
                    </div>
                    <div class="results-container">
                        ${resultsHtml}
                    </div>
                </div>
            </a>
        `;
    }).join('');

    const vnTime = new Date().toLocaleString("vi-VN", { timeZone: "Asia/Ho_Chi_Minh" });

    res.send(`
        <!DOCTYPE html>
        <html lang="vi">
        <head>
            <meta charset="UTF-8">
            <title>AE-SEXY Premium Intelligence</title>
            <meta name="viewport" content="width=device-width, initial-scale=1">
            <link href="https://fonts.googleapis.com/css2?family=Montserrat:wght@500;700;900&family=Inter:wght@400;600;800&display=swap" rel="stylesheet">
            <style>
                :root {
                    --bg-dark: #07090e;
                    --card-bg: rgba(18, 22, 33, 0.75);
                    --accent-p: #00f2fe;
                    --accent-b: #ff0844;
                    --accent-t: #00e676;
                    --gold: #f6d365;
                }

                * { box-sizing: border-box; }

                body { 
                    font-family: 'Inter', sans-serif; 
                    background-color: var(--bg-dark);
                    background-image: 
                        radial-gradient(circle at 15% 50%, rgba(0, 242, 254, 0.08), transparent 25%),
                        radial-gradient(circle at 85% 30%, rgba(255, 8, 68, 0.08), transparent 25%);
                    color: #e2e8f0; 
                    margin: 0; 
                    padding: 20px 15px; 
                    min-height: 100vh;
                    background-attachment: fixed;
                }
                
                .container { max-width: 1300px; margin: 0 auto; }
                
                header { 
                    text-align: center;
                    margin-bottom: 40px; 
                    padding: 40px 20px; 
                    background: linear-gradient(180deg, rgba(255,255,255,0.03) 0%, rgba(255,255,255,0) 100%);
                    border-radius: 24px; 
                    border: 1px solid rgba(255, 255, 255, 0.05);
                    position: relative;
                    overflow: hidden;
                }
                
                h1 { 
                    font-family: 'Montserrat', sans-serif;
                    margin: 0; 
                    font-size: 3.2em; 
                    font-weight: 900;
                    text-transform: uppercase;
                    letter-spacing: -1px;
                    background: linear-gradient(to right, #fff, #a5b4fc);
                    -webkit-background-clip: text;
                    -webkit-text-fill-color: transparent;
                    text-shadow: 0 0 30px rgba(165, 180, 252, 0.3);
                }
                
                .status-badge { 
                    display: inline-flex; 
                    align-items: center;
                    gap: 8px;
                    padding: 8px 20px; 
                    background: rgba(0, 230, 118, 0.1); 
                    color: #00e676;
                    border: 1px solid rgba(0, 230, 118, 0.3);
                    border-radius: 30px; 
                    font-size: 0.85em; 
                    margin-top: 20px; 
                    font-weight: 700;
                    letter-spacing: 1px;
                }

                .pulse-dot {
                    width: 8px;
                    height: 8px;
                    background-color: #00e676;
                    border-radius: 50%;
                    box-shadow: 0 0 0 0 rgba(0, 230, 118, 0.7);
                    animation: pulse-dot 1.5s infinite;
                }
                
                @keyframes pulse-dot {
                    0% { transform: scale(0.95); box-shadow: 0 0 0 0 rgba(0, 230, 118, 0.7); }
                    70% { transform: scale(1); box-shadow: 0 0 0 8px rgba(0, 230, 118, 0); }
                    100% { transform: scale(0.95); box-shadow: 0 0 0 0 rgba(0, 230, 118, 0); }
                }

                .main-controls { display: flex; justify-content: center; gap: 15px; margin-bottom: 40px; }

                .btn-primary {
                    background: rgba(255,255,255,0.05);
                    color: #fff;
                    padding: 12px 30px;
                    border-radius: 12px;
                    text-decoration: none;
                    font-weight: 600;
                    transition: all 0.3s ease;
                    border: 1px solid rgba(255,255,255,0.1);
                    backdrop-filter: blur(5px);
                }
                .btn-primary:hover { background: rgba(255,255,255,0.1); border-color: rgba(255,255,255,0.3); transform: translateY(-2px); }

                /* === GRID & CARDS === */
                .grid { 
                    display: grid; 
                    grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); 
                    gap: 24px; 
                }
                
                .card-link { text-decoration: none; color: inherit; display: block; outline: none; }

                .table-card { 
                    background: var(--card-bg); 
                    backdrop-filter: blur(12px);
                    -webkit-backdrop-filter: blur(12px);
                    padding: 24px; 
                    border-radius: 20px; 
                    border: 1px solid rgba(255, 255, 255, 0.06);
                    height: 100%;
                    display: flex;
                    flex-direction: column;
                    transition: all 0.4s cubic-bezier(0.175, 0.885, 0.32, 1.275);
                    box-shadow: 0 10px 30px -10px rgba(0,0,0,0.5);
                }
                
                .card-link:hover .table-card {
                    transform: translateY(-8px);
                    border-color: rgba(255, 255, 255, 0.2);
                    box-shadow: 0 20px 40px -10px rgba(0,0,0,0.8);
                }

                .card-header {
                    display: flex;
                    justify-content: space-between;
                    align-items: center;
                    margin-bottom: 20px;
                }
                
                .table-title { 
                    font-family: 'Montserrat', sans-serif;
                    font-size: 1.3em; 
                    font-weight: 800; 
                    color: #fff;
                    display: flex;
                    align-items: center;
                    gap: 8px;
                }
                .table-icon { color: #64748b; font-size: 1.2em; }

                .good-ro
