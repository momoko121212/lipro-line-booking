require('dotenv').config();
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const cors = require('cors');

const db = require('./db');
const { generateDailySlots, isClinicOpenOn } = require('./slots');
const line = require('./line');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());

// LINE webhook 需要用「原始 body」來驗證簽章，所以要在 express.json() 之前先掛一份 raw body middleware
app.use(
  express.json({
    verify: (req, _res, buf) => {
      req.rawBody = buf;
    },
  })
);

app.use(express.static(path.join(__dirname, '..', 'public')));

// ---------- 小工具 ----------

function isValidDateStr(s) {
  return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);
}

function isValidTimeStr(s) {
  return typeof s === 'string' && /^\d{2}:\d{2}$/.test(s);
}

function isValidPhone(s) {
  // 台灣常見手機/市話格式的寬鬆檢查（09xxxxxxxx 或含括號、-、空白的市話）
  return typeof s === 'string' && /^[0-9()\-+\s]{8,15}$/.test(s.trim());
}

// ---------- API：查詢某天的時段狀態（可預約 / 已額滿）----------

app.get('/api/slots', (req, res) => {
  const { date } = req.query;

  if (!isValidDateStr(date)) {
    return res.status(400).json({ error: '請提供正確格式的日期 (YYYY-MM-DD)' });
  }

  const today = new Date().toISOString().slice(0, 10);
  if (date < today) {
    return res.status(400).json({ error: '不可預約已過去的日期' });
  }

  if (!isClinicOpenOn(date)) {
    return res.json({ date, open: false, slots: [] });
  }

  const allSlots = generateDailySlots();

  const bookedRows = db
    .prepare(
      `SELECT slot_time FROM appointments WHERE slot_date = ? AND status = 'confirmed'`
    )
    .all(date);
  const bookedSet = new Set(bookedRows.map((r) => r.slot_time));

  const slots = allSlots.map((time) => ({
    time,
    available: !bookedSet.has(time),
  }));

  res.json({ date, open: true, slots });
});

// ---------- API：建立預約 ----------

app.post('/api/appointments', (req, res) => {
  const { name, phone, date, time, note, lineUserId } = req.body || {};

  if (!name || typeof name !== 'string' || name.trim().length === 0) {
    return res.status(400).json({ error: '請填寫預約大名' });
  }
  if (!isValidPhone(phone)) {
    return res.status(400).json({ error: '請填寫正確的聯絡電話' });
  }
  if (!isValidDateStr(date)) {
    return res.status(400).json({ error: '請選擇正確的預約日期' });
  }
  if (!isValidTimeStr(time)) {
    return res.status(400).json({ error: '請選擇預約時段' });
  }

  const today = new Date().toISOString().slice(0, 10);
  if (date < today) {
    return res.status(400).json({ error: '不可預約已過去的日期' });
  }

  if (!isClinicOpenOn(date)) {
    return res.status(400).json({ error: '該日期診所未開放預約' });
  }

  const allSlots = generateDailySlots();
  if (!allSlots.includes(time)) {
    return res.status(400).json({ error: '該時段不在看診時間內' });
  }

  try {
    const stmt = db.prepare(`
      INSERT INTO appointments (name, phone, slot_date, slot_time, note, line_user_id)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    const info = stmt.run(
      name.trim(),
      phone.trim(),
      date,
      time,
      (note || '').trim() || null,
      lineUserId || null
    );

    const appointment = db
      .prepare('SELECT * FROM appointments WHERE id = ?')
      .get(info.lastInsertRowid);

    // 預約成功後嘗試透過 LINE 推播確認訊息（若尚未設定 LINE 金鑰則會自動略過，不影響預約流程）
    line
      .pushMessage(
        lineUserId,
        `【麗波永康國際診所】預約成功通知\n姓名：${name}\n日期：${date}\n時段：${time}\n如需取消或更改，請直接透過本官方帳號與我們聯繫。`
      )
      .catch((err) => console.error('[LINE] 推播發生例外：', err));

    return res.status(201).json({ ok: true, appointment });
  } catch (err) {
    // UNIQUE constraint 觸發 = 該時段已在極短時間內被別人搶先預約（race condition）
    if (String(err.message).includes('UNIQUE constraint failed')) {
      return res.status(409).json({ error: '很抱歉，這個時段剛剛已被其他人預約，請重新選擇時段' });
    }
    console.error(err);
    return res.status(500).json({ error: '伺服器發生錯誤，請稍後再試' });
  }
});

// ---------- API：查詢單筆預約（可用於 LIFF 內顯示「我的預約」，之後可依 lineUserId 篩選）----------

app.get('/api/appointments', (req, res) => {
  const { lineUserId } = req.query;
  if (!lineUserId) {
    return res.status(400).json({ error: '缺少 lineUserId' });
  }
  const rows = db
    .prepare(
      `SELECT * FROM appointments WHERE line_user_id = ? AND status = 'confirmed' ORDER BY slot_date, slot_time`
    )
    .all(lineUserId);
  res.json({ appointments: rows });
});

// ---------- 管理端：查看所有預約（demo 用，之後可加上帳號密碼驗證）----------

app.get('/api/admin/appointments', (req, res) => {
  const rows = db
    .prepare(
      `SELECT * FROM appointments WHERE status = 'confirmed' ORDER BY slot_date, slot_time`
    )
    .all();
  res.json({ appointments: rows });
});

// ---------- LINE Webhook（接收使用者傳來的訊息/事件，例如加好友、傳送文字）----------

function verifyLineSignature(req) {
  if (!line.CHANNEL_SECRET) return true; // 尚未設定金鑰時，demo 階段先放行
  const signature = req.get('x-line-signature');
  if (!signature || !req.rawBody) return false;
  const hash = crypto
    .createHmac('sha256', line.CHANNEL_SECRET)
    .update(req.rawBody)
    .digest('base64');
  return hash === signature;
}

app.post('/webhook', (req, res) => {
  if (!verifyLineSignature(req)) {
    return res.status(401).send('signature validation failed');
  }

  const events = (req.body && req.body.events) || [];
  for (const event of events) {
    if (event.type === 'follow') {
      console.log('[LINE Webhook] 新的好友加入：', event.source && event.source.userId);
    }
    if (event.type === 'message' && event.message && event.message.type === 'text') {
      console.log('[LINE Webhook] 收到訊息：', event.message.text);
      // 之後可在這裡加入：如果使用者輸入「預約」，回覆一個 LIFF 預約連結
    }
  }

  res.status(200).send('OK');
});

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, lineConfigured: line.isConfigured });
});

app.listen(PORT, () => {
  console.log(`麗波永康國際診所預約系統已啟動：http://localhost:${PORT}`);
  console.log(`LINE Messaging API 設定狀態：${line.isConfigured ? '已設定' : '尚未設定（demo 模式）'}`);
});
