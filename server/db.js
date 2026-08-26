const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const dataDir = path.join(__dirname, '..', 'data');
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

const dbPath = path.join(dataDir, 'booking.db');
const db = new Database(dbPath);

db.pragma('journal_mode = WAL');

// 預約資料表（首頁：選日期時段預約）
// slot_date + slot_time 建立 UNIQUE 索引，從資料庫層級防止「同一時段被重複預約」的競態問題（race condition）
db.exec(`
  CREATE TABLE IF NOT EXISTS appointments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    phone TEXT NOT NULL,
    slot_date TEXT NOT NULL,      -- YYYY-MM-DD
    slot_time TEXT NOT NULL,      -- HH:MM (該時段起始時間)
    note TEXT,
    line_user_id TEXT,            -- 之後串接 LINE LIFF 後可寫入 LINE 使用者 ID
    status TEXT NOT NULL DEFAULT 'confirmed', -- confirmed / cancelled
    created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
  );
`);

db.exec(`
  CREATE UNIQUE INDEX IF NOT EXISTS idx_unique_active_slot
  ON appointments (slot_date, slot_time)
  WHERE status = 'confirmed';
`);

// 諮詢師每週空檔時間表（後台每週打勾設定，客人預約時只能從這裡面挑）
// consultant + slot_date + slot_time 建立唯一索引，避免同一位諮詢師同一時段被重複開放
db.exec(`
  CREATE TABLE IF NOT EXISTS weekly_availability (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    consultant TEXT NOT NULL,        -- 'A' / 'B' / 'C' / 'D'
    slot_date TEXT NOT NULL,         -- YYYY-MM-DD
    slot_time TEXT NOT NULL,         -- HH:MM
    is_booked INTEGER NOT NULL DEFAULT 0,  -- 0=空檔可選 / 1=已被後台確認的預約佔用
    created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
  );
`);

db.exec(`
  CREATE UNIQUE INDEX IF NOT EXISTS idx_unique_consultant_slot
  ON weekly_availability (consultant, slot_date, slot_time);
`);

// 客人送出的預約「意願清單」——客人可勾選多個方便的時段（可能來自不同諮詢師），
// 這裡先只是留資，實際只會有其中一筆被後台人工確認、指派成正式預約。
db.exec(`
  CREATE TABLE IF NOT EXISTS booking_requests (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    phone TEXT NOT NULL,
    consultant_preference TEXT,      -- 客人指定的諮詢師代碼，NULL 代表「不指定」
    selections TEXT NOT NULL,        -- JSON 陣列：[{"consultant":"A","date":"2026-08-25","time":"10:00"}, ...]
    note TEXT,
    status TEXT NOT NULL DEFAULT 'pending', -- pending / confirmed / cancelled
    confirmed_consultant TEXT,
    confirmed_date TEXT,
    confirmed_time TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
  );
`);

// 胸型重塑評估表單資料表（/gynecomastia 頁面）
// 這是「諮詢評估留資」用途，不是時段預約，所以不需要唯一索引限制——
// 同一個回電時段區間允許很多人一起留資，由專員之後逐一致電安排。
db.exec(`
  CREATE TABLE IF NOT EXISTS consultations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    height TEXT,
    weight TEXT,
    exercise_habit TEXT,       -- 運動/重訓習慣
    prior_surgery TEXT,        -- 是否曾做過手術
    body_type TEXT,            -- 自評體態型態（脂肪型/乳腺型/鬆弛型/不確定）
    name TEXT NOT NULL,
    phone TEXT NOT NULL,
    preferred_date TEXT,       -- 方便回電的日期 YYYY-MM-DD（選填）
    preferred_time_slots TEXT, -- 方便接聽電話時段，多選以逗號分隔
    note TEXT,
    status TEXT NOT NULL DEFAULT 'new', -- new / contacted / closed
    created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
  );
`);

module.exports = db;
