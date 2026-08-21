const path = require('path');
const Database = require('better-sqlite3');

const dbPath = path.join(__dirname, '..', 'data', 'booking.db');
const db = new Database(dbPath);

db.pragma('journal_mode = WAL');

// 預約資料表
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

module.exports = db;
