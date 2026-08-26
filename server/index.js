require('dotenv').config();
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const cors = require('cors');

const db = require('./db');
const { generateDailySlots, isClinicOpenOn } = require('./slots');
const line = require('./line');

// 諮詢師代碼清單。之後如需增減人數，只要改這裡，其他程式碼都不用動。
const CONSULTANTS = ['A', 'B', 'C', 'D'];
const CONSULTANT_LABELS = {
  A: '諮詢師 A',
  B: '諮詢師 B',
  C: '諮詢師 C',
  D: '諮詢師 D',
};

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

// 取得「台灣時間」現在的日期與時間字串，不管伺服器主機本身設定在哪個時區都會準確
// （避免直接用 new Date().toISOString() 導致以 UTC 時間誤判今天日期/現在時刻）
function getTaipeiNow() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Taipei',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(new Date());
  const map = {};
  parts.forEach((p) => {
    map[p.type] = p.value;
  });
  return {
    dateStr: `${map.year}-${map.month}-${map.day}`,
    timeStr: `${map.hour}:${map.minute}`,
  };
}

// ---------- API：查詢某天的時段狀態（可預約 / 已額滿）----------

app.get('/api/slots', (req, res) => {
  const { date } = req.query;

  if (!isValidDateStr(date)) {
    return res.status(400).json({ error: '請提供正確格式的日期 (YYYY-MM-DD)' });
  }

  const { dateStr: todayStr, timeStr: nowTimeStr } = getTaipeiNow();
  if (date < todayStr) {
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

  // 如果查詢的日期就是今天，把已經過去的時段也標記為不可預約
  const isToday = date === todayStr;

  const slots = allSlots.map((time) => ({
    time,
    available: !bookedSet.has(time) && !(isToday && time <= nowTimeStr),
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

  const { dateStr: todayStr, timeStr: nowTimeStr } = getTaipeiNow();
  if (date < todayStr) {
    return res.status(400).json({ error: '不可預約已過去的日期' });
  }
  if (date === todayStr && time <= nowTimeStr) {
    return res.status(400).json({ error: '這個時段已經過去，請重新選擇時段' });
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

// ---------- API：查詢諮詢師空檔時段（客人填寫預約表單用）----------
// consultant 不帶或帶空字串 = 不指定諮詢師，回傳所有人的空檔

app.get('/api/availability', (req, res) => {
  const { consultant } = req.query;

  if (consultant && !CONSULTANTS.includes(consultant)) {
    return res.status(400).json({ error: '諮詢師代碼不正確' });
  }

  const { dateStr: todayStr, timeStr: nowTimeStr } = getTaipeiNow();

  let rows;
  if (consultant) {
    rows = db
      .prepare(
        `SELECT consultant, slot_date AS date, slot_time AS time FROM weekly_availability
         WHERE is_booked = 0 AND consultant = ?
         ORDER BY slot_date, slot_time`
      )
      .all(consultant);
  } else {
    rows = db
      .prepare(
        `SELECT consultant, slot_date AS date, slot_time AS time FROM weekly_availability
         WHERE is_booked = 0
         ORDER BY slot_date, slot_time`
      )
      .all();
  }

  // 過濾掉已經過去的時段（用台灣時間判斷）
  const slots = rows.filter(
    (r) => r.date > todayStr || (r.date === todayStr && r.time > nowTimeStr)
  );

  res.json({
    slots,
    consultantLabels: CONSULTANT_LABELS,
  });
});

// ---------- API：客人送出預約意願清單（可複選多個時段/諮詢師）----------

app.post('/api/booking-requests', (req, res) => {
  const { name, phone, consultantPreference, selections, note } = req.body || {};

  if (!name || typeof name !== 'string' || name.trim().length === 0) {
    return res.status(400).json({ error: '請填寫預約大名' });
  }
  if (!isValidPhone(phone)) {
    return res.status(400).json({ error: '請填寫正確的聯絡電話' });
  }
  if (consultantPreference && !CONSULTANTS.includes(consultantPreference)) {
    return res.status(400).json({ error: '諮詢師代碼不正確' });
  }
  if (!Array.isArray(selections) || selections.length === 0) {
    return res.status(400).json({ error: '請至少勾選一個方便的時段' });
  }
  for (const sel of selections) {
    if (
      !sel ||
      !CONSULTANTS.includes(sel.consultant) ||
      !isValidDateStr(sel.date) ||
      !isValidTimeStr(sel.time)
    ) {
      return res.status(400).json({ error: '選擇的時段格式不正確，請重新整理頁面再試一次' });
    }
  }

  // 確認每個勾選的時段目前都還是「空檔、未被預約」的狀態，避免使用舊資料誤送出
  const placeholders = selections
    .map(() => '(consultant = ? AND slot_date = ? AND slot_time = ? AND is_booked = 0)')
    .join(' OR ');
  const params = selections.flatMap((s) => [s.consultant, s.date, s.time]);
  const matchCount = db
    .prepare(`SELECT COUNT(*) AS c FROM weekly_availability WHERE ${placeholders}`)
    .get(...params).c;
  if (matchCount !== selections.length) {
    return res
      .status(409)
      .json({ error: '您選擇的時段中有部分已被其他人預約或已不存在，請重新整理頁面再選一次' });
  }

  try {
    const stmt = db.prepare(`
      INSERT INTO booking_requests (name, phone, consultant_preference, selections, note)
      VALUES (?, ?, ?, ?, ?)
    `);
    const info = stmt.run(
      name.trim(),
      phone.trim(),
      consultantPreference || null,
      JSON.stringify(selections),
      (note || '').trim() || null
    );
    const request = db.prepare('SELECT * FROM booking_requests WHERE id = ?').get(info.lastInsertRowid);
    return res.status(201).json({ ok: true, request: { ...request, selections: JSON.parse(request.selections) } });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: '伺服器發生錯誤，請稍後再試' });
  }
});

// ---------- API：建立「胸型重塑評估」諮詢表單留資（/gynecomastia 頁面用）----------
// 這是留資讓專員回電的表單，不是選時段預約，所以不檢查時段衝突，
// 只做基本必填欄位驗證。

app.post('/api/consultations', (req, res) => {
  const {
    height,
    weight,
    exerciseHabit,
    priorSurgery,
    bodyType,
    name,
    phone,
    preferredDate,
    preferredTimeSlots,
    note,
  } = req.body || {};

  if (!name || typeof name !== 'string' || name.trim().length === 0) {
    return res.status(400).json({ error: '請填寫姓名或稱呼' });
  }
  if (!isValidPhone(phone)) {
    return res.status(400).json({ error: '請填寫正確的聯絡電話' });
  }
  if (!exerciseHabit) {
    return res.status(400).json({ error: '請選擇運動/重訓習慣' });
  }
  if (!priorSurgery) {
    return res.status(400).json({ error: '請選擇是否曾做過手術' });
  }
  if (!bodyType) {
    return res.status(400).json({ error: '請選擇您的體態型態' });
  }
  if (preferredDate && !isValidDateStr(preferredDate)) {
    return res.status(400).json({ error: '回電日期格式不正確' });
  }
  if (
    !preferredTimeSlots ||
    !Array.isArray(preferredTimeSlots) ||
    preferredTimeSlots.length === 0
  ) {
    return res.status(400).json({ error: '請至少選擇一個方便接聽電話的時段' });
  }

  try {
    const stmt = db.prepare(`
      INSERT INTO consultations
        (height, weight, exercise_habit, prior_surgery, body_type, name, phone, preferred_date, preferred_time_slots, note)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const info = stmt.run(
      (height || '').trim() || null,
      (weight || '').trim() || null,
      exerciseHabit,
      priorSurgery,
      bodyType,
      name.trim(),
      phone.trim(),
      preferredDate || null,
      preferredTimeSlots.join(','),
      (note || '').trim() || null
    );

    const consultation = db
      .prepare('SELECT * FROM consultations WHERE id = ?')
      .get(info.lastInsertRowid);

    return res.status(201).json({ ok: true, consultation });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: '伺服器發生錯誤，請稍後再試' });
  }
});

// ---------- 管理端保護：需要帳號密碼才能查看預約 ----------
// 帳號密碼設定在 Render 的 Environment Variables（ADMIN_USER / ADMIN_PASSWORD），
// 不會寫在程式碼裡，所以就算 GitHub repo 是公開的也不會外洩密碼。
// 如果還沒設定這兩個環境變數，管理頁面會先保持開放（並在記錄裡提醒），方便demo階段測試。

function requireAdminAuth(req, res, next) {
  const expectedUser = process.env.ADMIN_USER;
  const expectedPass = process.env.ADMIN_PASSWORD;

  if (!expectedUser || !expectedPass) {
    console.warn('[Admin] 尚未設定 ADMIN_USER / ADMIN_PASSWORD，管理頁面目前沒有密碼保護');
    return next();
  }

  const authHeader = req.headers.authorization || '';
  const [scheme, encoded] = authHeader.split(' ');

  if (scheme === 'Basic' && encoded) {
    const decoded = Buffer.from(encoded, 'base64').toString('utf8');
    const sepIndex = decoded.indexOf(':');
    const reqUser = decoded.slice(0, sepIndex);
    const reqPass = decoded.slice(sepIndex + 1);
    if (reqUser === expectedUser && reqPass === expectedPass) {
      return next();
    }
  }

  res.set('WWW-Authenticate', 'Basic realm="Admin Area"');
  return res.status(401).send('需要登入才能查看此頁面');
}

// ---------- 管理端：查看所有預約 ----------

app.get('/api/admin/appointments', requireAdminAuth, (req, res) => {
  const rows = db
    .prepare(
      `SELECT * FROM appointments WHERE status = 'confirmed' ORDER BY slot_date, slot_time`
    )
    .all();
  res.json({ appointments: rows });
});

// ---------- 管理端：查詢/切換某一週的諮詢師空檔表 ----------
// weekStart 為該週第一天（YYYY-MM-DD），會回傳這 7 天、每位諮詢師、每個時段目前是否開放

app.get('/api/admin/schedule', requireAdminAuth, (req, res) => {
  const { weekStart } = req.query;
  if (!isValidDateStr(weekStart)) {
    return res.status(400).json({ error: '請提供正確的週起始日期 (YYYY-MM-DD)' });
  }

  const dates = [];
  const start = new Date(`${weekStart}T00:00:00`);
  for (let i = 0; i < 7; i++) {
    const d = new Date(start);
    d.setDate(d.getDate() + i);
    dates.push(d.toISOString().slice(0, 10));
  }

  const placeholders = dates.map(() => '?').join(',');
  const openRows = db
    .prepare(
      `SELECT consultant, slot_date, slot_time, is_booked FROM weekly_availability WHERE slot_date IN (${placeholders})`
    )
    .all(...dates);

  const openMap = {};
  openRows.forEach((r) => {
    openMap[`${r.consultant}|${r.slot_date}|${r.slot_time}`] = r.is_booked;
  });

  res.json({
    dates,
    consultants: CONSULTANTS,
    consultantLabels: CONSULTANT_LABELS,
    timeSlots: generateDailySlots(),
    openMap,
  });
});

app.post('/api/admin/schedule/toggle', requireAdminAuth, (req, res) => {
  const { consultant, date, time, open } = req.body || {};

  if (!CONSULTANTS.includes(consultant) || !isValidDateStr(date) || !isValidTimeStr(time)) {
    return res.status(400).json({ error: '參數不正確' });
  }

  if (open) {
    db.prepare(
      `INSERT OR IGNORE INTO weekly_availability (consultant, slot_date, slot_time) VALUES (?, ?, ?)`
    ).run(consultant, date, time);
  } else {
    const result = db
      .prepare(
        `DELETE FROM weekly_availability WHERE consultant = ? AND slot_date = ? AND slot_time = ? AND is_booked = 0`
      )
      .run(consultant, date, time);
    if (result.changes === 0) {
      // 若該時段已經被確認預約佔用，不允許直接關閉，要先去「預約留資管理」處理
      const existing = db
        .prepare(
          `SELECT is_booked FROM weekly_availability WHERE consultant = ? AND slot_date = ? AND slot_time = ?`
        )
        .get(consultant, date, time);
      if (existing && existing.is_booked) {
        return res
          .status(409)
          .json({ error: '這個時段已經有確認的預約，請先到「預約留資管理」取消該筆預約' });
      }
    }
  }

  res.json({ ok: true });
});

// ---------- 管理端：查看/確認客人送出的預約意願清單 ----------

app.get('/api/admin/booking-requests', requireAdminAuth, (req, res) => {
  const { status } = req.query;
  const rows = status
    ? db.prepare(`SELECT * FROM booking_requests WHERE status = ? ORDER BY created_at DESC`).all(status)
    : db.prepare(`SELECT * FROM booking_requests ORDER BY created_at DESC`).all();

  res.json({
    requests: rows.map((r) => ({ ...r, selections: JSON.parse(r.selections) })),
    consultantLabels: CONSULTANT_LABELS,
  });
});

app.post('/api/admin/booking-requests/:id/confirm', requireAdminAuth, (req, res) => {
  const id = Number(req.params.id);
  const { consultant, date, time } = req.body || {};

  if (!CONSULTANTS.includes(consultant) || !isValidDateStr(date) || !isValidTimeStr(time)) {
    return res.status(400).json({ error: '參數不正確' });
  }

  const request = db.prepare('SELECT * FROM booking_requests WHERE id = ?').get(id);
  if (!request) {
    return res.status(404).json({ error: '找不到這筆留資' });
  }
  if (request.status === 'confirmed') {
    return res.status(409).json({ error: '這筆留資已經確認過了' });
  }

  const slot = db
    .prepare(`SELECT * FROM weekly_availability WHERE consultant = ? AND slot_date = ? AND slot_time = ?`)
    .get(consultant, date, time);
  if (!slot) {
    return res.status(400).json({ error: '這個時段目前不存在於空檔表中，請確認後台排班設定' });
  }
  if (slot.is_booked) {
    return res.status(409).json({ error: '這個時段已經被其他預約佔用，請選擇別的時段' });
  }

  db.prepare(`UPDATE weekly_availability SET is_booked = 1 WHERE id = ?`).run(slot.id);
  db.prepare(
    `UPDATE booking_requests SET status = 'confirmed', confirmed_consultant = ?, confirmed_date = ?, confirmed_time = ? WHERE id = ?`
  ).run(consultant, date, time, id);

  const updated = db.prepare('SELECT * FROM booking_requests WHERE id = ?').get(id);
  res.json({ ok: true, request: { ...updated, selections: JSON.parse(updated.selections) } });
});

app.post('/api/admin/booking-requests/:id/cancel', requireAdminAuth, (req, res) => {
  const id = Number(req.params.id);
  const request = db.prepare('SELECT * FROM booking_requests WHERE id = ?').get(id);
  if (!request) {
    return res.status(404).json({ error: '找不到這筆留資' });
  }

  // 若這筆留資先前已經確認過某個時段，取消時要把該時段重新開放
  if (request.status === 'confirmed' && request.confirmed_consultant) {
    db.prepare(
      `UPDATE weekly_availability SET is_booked = 0 WHERE consultant = ? AND slot_date = ? AND slot_time = ?`
    ).run(request.confirmed_consultant, request.confirmed_date, request.confirmed_time);
  }

  db.prepare(
    `UPDATE booking_requests SET status = 'cancelled', confirmed_consultant = NULL, confirmed_date = NULL, confirmed_time = NULL WHERE id = ?`
  ).run(id);

  res.json({ ok: true });
});

// ---------- 管理端網頁：預約總覽（方便診所人員查看）----------

app.get('/admin', requireAdminAuth, (_req, res) => {
  res.send(`<!doctype html>
<html lang="zh-Hant">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>預約總覽 - 麗波永康國際診所</title>
<style>
  body{font-family:-apple-system,BlinkMacSystemFont,"PingFang TC","Noto Sans TC",sans-serif;background:#f5f8f7;margin:0;padding:20px;color:#26312e;}
  h1{font-size:18px;color:#1f6b5e;}
  a.tolink{font-size:13px;color:#1f6b5e;margin-right:16px;}
  .links{margin-bottom:8px;}
  table{width:100%;border-collapse:collapse;background:#fff;border-radius:8px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,.05);}
  th,td{padding:10px 12px;text-align:left;border-bottom:1px solid #e1e8e6;font-size:14px;}
  th{background:#eef7f4;color:#1f6b5e;}
  tr:last-child td{border-bottom:none;}
  .empty{color:#7c8a86;padding:20px;text-align:center;}
  .refresh{font-size:12px;color:#7c8a86;margin-bottom:12px;}
</style>
</head>
<body>
  <h1>麗波永康國際診所｜預約總覽</h1>
  <div class="links">
    <a class="tolink" href="/admin/schedule">諮詢師排班設定 &rarr;</a>
    <a class="tolink" href="/admin/booking-requests">預約留資與確認 &rarr;</a>
    <a class="tolink" href="/admin/consultations">查看胸型重塑評估表單留資 &rarr;</a>
  </div>
  <div class="refresh">每 30 秒自動更新一次</div>
  <div id="content">載入中...</div>
  <script>
    async function load() {
      try {
        const res = await fetch('/api/admin/appointments');
        const data = await res.json();
        const rows = data.appointments || [];
        if (rows.length === 0) {
          document.getElementById('content').innerHTML = '<div class="empty">目前沒有任何預約</div>';
          return;
        }
        let html = '<table><thead><tr><th>日期</th><th>時段</th><th>姓名</th><th>電話</th><th>備註</th><th>建立時間</th></tr></thead><tbody>';
        rows.forEach(r => {
          html += '<tr><td>' + r.slot_date + '</td><td>' + r.slot_time + '</td><td>' + r.name + '</td><td>' + r.phone + '</td><td>' + (r.note || '') + '</td><td>' + r.created_at + '</td></tr>';
        });
        html += '</tbody></table>';
        document.getElementById('content').innerHTML = html;
      } catch (err) {
        document.getElementById('content').innerHTML = '<div class="empty">載入失敗，請重新整理</div>';
      }
    }
    load();
    setInterval(load, 30000);
  </script>
</body>
</html>`);
});

// ---------- 管理端網頁：諮詢師每週排班設定（打勾開放/關閉時段）----------

app.get('/admin/schedule', requireAdminAuth, (_req, res) => {
  res.send(`<!doctype html>
<html lang="zh-Hant">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>諮詢師排班設定 - 麗波永康國際診所</title>
<style>
  body{font-family:-apple-system,BlinkMacSystemFont,"PingFang TC","Noto Sans TC",sans-serif;background:#f5f8f7;margin:0;padding:20px;color:#26312e;}
  h1{font-size:18px;color:#1f6b5e;margin-bottom:4px;}
  a.back{font-size:13px;color:#1f6b5e;}
  .toolbar{display:flex;flex-wrap:wrap;align-items:center;gap:10px;margin:14px 0;}
  .tabs{display:flex;gap:6px;}
  .tab{padding:8px 14px;border-radius:8px;border:1px solid #e1e8e6;background:#fff;cursor:pointer;font-size:14px;}
  .tab.active{background:#2f8f7f;color:#fff;border-color:#2f8f7f;}
  .weeknav{display:flex;align-items:center;gap:8px;margin-left:auto;}
  .weeknav button{padding:8px 12px;border-radius:8px;border:1px solid #e1e8e6;background:#fff;cursor:pointer;font-size:13px;}
  .weekLabel{font-size:13px;color:#7c8a86;}
  .tablewrap{overflow-x:auto;background:#fff;border-radius:8px;box-shadow:0 1px 3px rgba(0,0,0,.05);}
  table{border-collapse:collapse;width:100%;min-width:760px;}
  th,td{padding:6px 8px;text-align:center;border-bottom:1px solid #eef1f0;font-size:12px;white-space:nowrap;}
  th{background:#eef7f4;color:#1f6b5e;position:sticky;top:0;}
  td.timecol,th.timecol{position:sticky;left:0;background:#fbfcfc;text-align:left;font-weight:600;color:#26312e;z-index:1;}
  th.timecol{background:#eef7f4;z-index:2;}
  input[type=checkbox]{width:18px;height:18px;cursor:pointer;}
  input[type=checkbox]:disabled{cursor:not-allowed;}
  .booked{background:#fff8ec;}
  .hint{font-size:12px;color:#7c8a86;margin:8px 0;}
  .msg{font-size:13px;padding:8px 12px;border-radius:8px;margin:10px 0;display:none;}
  .msg.show{display:block;}
  .msg.error{background:#fcebeb;color:#d64545;}
</style>
</head>
<body>
  <a class="back" href="/admin">&larr; 回預約總覽</a>
  <h1>諮詢師每週排班設定</h1>
  <div class="hint">打勾 = 該時段開放給客人預約；淺黃色底 = 已經有客人被確認預約，無法直接取消（請到「預約留資與確認」處理）。</div>

  <div class="toolbar">
    <div class="tabs" id="tabs"></div>
    <div class="weeknav">
      <button id="prevWeek">&larr; 上一週</button>
      <span class="weekLabel" id="weekLabel"></span>
      <button id="nextWeek">下一週 &rarr;</button>
    </div>
  </div>

  <div class="msg error" id="msgBox"></div>
  <div class="tablewrap"><table id="grid"></table></div>

<script>
(function () {
  const CONSULTANTS = ${JSON.stringify(CONSULTANTS)};
  const LABELS = ${JSON.stringify(CONSULTANT_LABELS)};
  let currentConsultant = CONSULTANTS[0];
  let weekStart = getMonday(new Date());

  function getMonday(d) {
    const date = new Date(d);
    const day = date.getDay();
    const diff = (day === 0 ? -6 : 1) - day; // 週一為第一天
    date.setDate(date.getDate() + diff);
    return date;
  }
  function fmt(d) {
    return d.toISOString().slice(0, 10);
  }
  function addDays(d, n) {
    const date = new Date(d);
    date.setDate(date.getDate() + n);
    return date;
  }

  const tabsEl = document.getElementById('tabs');
  const weekLabelEl = document.getElementById('weekLabel');
  const gridEl = document.getElementById('grid');
  const msgBox = document.getElementById('msgBox');

  function showError(text) {
    msgBox.textContent = text;
    msgBox.className = 'msg error show';
  }
  function clearError() {
    msgBox.className = 'msg';
  }

  function renderTabs() {
    tabsEl.innerHTML = '';
    CONSULTANTS.forEach((c) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'tab' + (c === currentConsultant ? ' active' : '');
      btn.textContent = LABELS[c] || c;
      btn.addEventListener('click', () => {
        currentConsultant = c;
        renderTabs();
        loadWeek();
      });
      tabsEl.appendChild(btn);
    });
  }

  async function toggleSlot(date, time, open) {
    clearError();
    try {
      const res = await fetch('/api/admin/schedule/toggle', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ consultant: currentConsultant, date, time, open }),
      });
      const data = await res.json();
      if (!res.ok) {
        showError(data.error || '操作失敗');
        return false;
      }
      return true;
    } catch (err) {
      showError('無法連線到伺服器，請稍後再試');
      return false;
    }
  }

  async function loadWeek() {
    clearError();
    const ws = fmt(weekStart);
    weekLabelEl.textContent = ws + ' 起的一週';
    gridEl.innerHTML = '<tr><td style="padding:16px;">載入中...</td></tr>';
    try {
      const res = await fetch('/api/admin/schedule?weekStart=' + ws);
      const data = await res.json();
      if (!res.ok) {
        showError(data.error || '載入失敗');
        return;
      }
      renderGrid(data);
    } catch (err) {
      showError('無法連線到伺服器，請稍後再試');
    }
  }

  function renderGrid(data) {
    const { dates, timeSlots, openMap } = data;
    let html = '<thead><tr><th class="timecol">時段</th>';
    dates.forEach((d) => {
      html += '<th>' + d.slice(5) + '</th>';
    });
    html += '</tr></thead><tbody>';

    timeSlots.forEach((time) => {
      html += '<tr><td class="timecol">' + time + '</td>';
      dates.forEach((date) => {
        const key = currentConsultant + '|' + date + '|' + time;
        const state = openMap[key];
        const isOpen = state !== undefined;
        const isBooked = state === 1;
        html +=
          '<td class="' + (isBooked ? 'booked' : '') + '">' +
          '<input type="checkbox" data-date="' + date + '" data-time="' + time + '"' +
          (isOpen ? ' checked' : '') +
          (isBooked ? ' disabled' : '') +
          ' />' +
          '</td>';
      });
      html += '</tr>';
    });
    html += '</tbody>';
    gridEl.innerHTML = html;

    gridEl.querySelectorAll('input[type=checkbox]').forEach((cb) => {
      cb.addEventListener('change', async () => {
        const ok = await toggleSlot(cb.dataset.date, cb.dataset.time, cb.checked);
        if (!ok) {
          cb.checked = !cb.checked; // 失敗就還原勾選狀態
        }
      });
    });
  }

  document.getElementById('prevWeek').addEventListener('click', () => {
    weekStart = addDays(weekStart, -7);
    loadWeek();
  });
  document.getElementById('nextWeek').addEventListener('click', () => {
    weekStart = addDays(weekStart, 7);
    loadWeek();
  });

  renderTabs();
  loadWeek();
})();
</script>
</body>
</html>`);
});

// ---------- 管理端網頁：預約留資與確認 ----------

app.get('/admin/booking-requests', requireAdminAuth, (_req, res) => {
  res.send(`<!doctype html>
<html lang="zh-Hant">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>預約留資與確認 - 麗波永康國際診所</title>
<style>
  body{font-family:-apple-system,BlinkMacSystemFont,"PingFang TC","Noto Sans TC",sans-serif;background:#f5f8f7;margin:0;padding:20px;color:#26312e;}
  h1{font-size:18px;color:#1f6b5e;}
  a.back{font-size:13px;color:#1f6b5e;}
  .refresh{font-size:12px;color:#7c8a86;margin:8px 0;}
  .card{background:#fff;border-radius:10px;padding:14px 16px;margin-bottom:12px;box-shadow:0 1px 3px rgba(0,0,0,.05);border:1px solid #e1e8e6;}
  .card.pending{border-left:4px solid #e0a530;}
  .card.confirmed{border-left:4px solid #2f8f7f;}
  .card.cancelled{border-left:4px solid #b7bdba;opacity:0.7;}
  .row{font-size:13px;margin:4px 0;}
  .row b{color:#1f6b5e;}
  .badge{display:inline-block;font-size:11px;padding:2px 8px;border-radius:20px;margin-left:6px;}
  .badge.pending{background:#fff3de;color:#8a6414;}
  .badge.confirmed{background:#e5f4ee;color:#1f6b5e;}
  .badge.cancelled{background:#eee;color:#7c8a86;}
  .selections{display:flex;flex-wrap:wrap;gap:6px;margin:8px 0;}
  .sel-btn{padding:6px 10px;border-radius:8px;border:1px solid #e1e8e6;background:#fbfcfc;font-size:12px;cursor:pointer;}
  .sel-btn:hover{border-color:#2f8f7f;}
  .actions{margin-top:8px;}
  .actions button{padding:7px 12px;border-radius:8px;border:none;font-size:12px;cursor:pointer;margin-right:6px;}
  .btn-cancel{background:#fcebeb;color:#d64545;}
  .empty{color:#7c8a86;padding:20px;text-align:center;}
</style>
</head>
<body>
  <a class="back" href="/admin">&larr; 回預約總覽</a>
  <h1>預約留資與確認</h1>
  <div class="refresh">點選客人勾選的其中一個時段即可確認預約；每 30 秒自動更新一次</div>
  <div id="content">載入中...</div>

<script>
(function () {
  const content = document.getElementById('content');

  async function confirmSelection(id, sel) {
    if (!confirm('確定要將此客人指派為 ' + sel.consultant + ' / ' + sel.date + ' ' + sel.time + ' 嗎？')) return;
    try {
      const res = await fetch('/api/admin/booking-requests/' + id + '/confirm', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ consultant: sel.consultant, date: sel.date, time: sel.time }),
      });
      const data = await res.json();
      if (!res.ok) {
        alert(data.error || '確認失敗');
        return;
      }
      load();
    } catch (err) {
      alert('無法連線到伺服器，請稍後再試');
    }
  }

  async function cancelRequest(id) {
    if (!confirm('確定要取消這筆留資嗎？')) return;
    try {
      const res = await fetch('/api/admin/booking-requests/' + id + '/cancel', { method: 'POST' });
      const data = await res.json();
      if (!res.ok) {
        alert(data.error || '取消失敗');
        return;
      }
      load();
    } catch (err) {
      alert('無法連線到伺服器，請稍後再試');
    }
  }

  async function load() {
    try {
      const res = await fetch('/api/admin/booking-requests');
      const data = await res.json();
      const rows = data.requests || [];
      const labels = data.consultantLabels || {};
      if (rows.length === 0) {
        content.innerHTML = '<div class="empty">目前沒有任何留資</div>';
        return;
      }
      let html = '';
      rows.forEach((r) => {
        html += '<div class="card ' + r.status + '">';
        html += '<div class="row"><b>' + r.name + '</b>（' + r.phone + '）<span class="badge ' + r.status + '">' +
          (r.status === 'pending' ? '待確認' : r.status === 'confirmed' ? '已確認' : '已取消') + '</span></div>';
        html += '<div class="row">指定諮詢師：' + (r.consultant_preference ? (labels[r.consultant_preference] || r.consultant_preference) : '不指定') + '</div>';
        if (r.note) html += '<div class="row">備註：' + r.note + '</div>';
        html += '<div class="row">建立時間：' + r.created_at + '</div>';

        if (r.status === 'pending') {
          html += '<div class="row">客人勾選的意願時段（點選其中一個確認）：</div>';
          html += '<div class="selections">';
          r.selections.forEach((sel, i) => {
            html += '<button class="sel-btn" data-id="' + r.id + '" data-i="' + i + '">' +
              (labels[sel.consultant] || sel.consultant) + ' ' + sel.date + ' ' + sel.time + '</button>';
          });
          html += '</div>';
          html += '<div class="actions"><button class="btn-cancel" data-cancel="' + r.id + '">取消此留資</button></div>';
        } else if (r.status === 'confirmed') {
          html += '<div class="row">已確認：' + (labels[r.confirmed_consultant] || r.confirmed_consultant) + ' ' + r.confirmed_date + ' ' + r.confirmed_time + '</div>';
          html += '<div class="actions"><button class="btn-cancel" data-cancel="' + r.id + '">取消此預約</button></div>';
        }
        html += '</div>';
      });
      content.innerHTML = html;

      content.querySelectorAll('.sel-btn').forEach((btn) => {
        btn.addEventListener('click', () => {
          const row = rows.find((r) => String(r.id) === btn.dataset.id);
          const sel = row.selections[Number(btn.dataset.i)];
          confirmSelection(btn.dataset.id, sel);
        });
      });
      content.querySelectorAll('[data-cancel]').forEach((btn) => {
        btn.addEventListener('click', () => cancelRequest(btn.dataset.cancel));
      });
    } catch (err) {
      content.innerHTML = '<div class="empty">載入失敗，請重新整理</div>';
    }
  }

  load();
  setInterval(load, 30000);
})();
</script>
</body>
</html>`);
});

// ---------- 管理端：查看所有胸型重塑評估表單留資 ----------

app.get('/api/admin/consultations', requireAdminAuth, (req, res) => {
  const rows = db
    .prepare(`SELECT * FROM consultations ORDER BY created_at DESC`)
    .all();
  res.json({ consultations: rows });
});

// ---------- 管理端網頁：胸型重塑評估表單留資總覽 ----------

app.get('/admin/consultations', requireAdminAuth, (_req, res) => {
  res.send(`<!doctype html>
<html lang="zh-Hant">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>評估表單留資總覽 - 麗波永康國際診所</title>
<style>
  body{font-family:-apple-system,BlinkMacSystemFont,"PingFang TC","Noto Sans TC",sans-serif;background:#f5f8f7;margin:0;padding:20px;color:#26312e;}
  h1{font-size:18px;color:#1f6b5e;}
  a.back{font-size:13px;color:#1f6b5e;}
  table{width:100%;border-collapse:collapse;background:#fff;border-radius:8px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,.05);margin-top:12px;}
  th,td{padding:10px 12px;text-align:left;border-bottom:1px solid #e1e8e6;font-size:13px;vertical-align:top;}
  th{background:#eef7f4;color:#1f6b5e;}
  tr:last-child td{border-bottom:none;}
  .empty{color:#7c8a86;padding:20px;text-align:center;}
  .refresh{font-size:12px;color:#7c8a86;margin:8px 0;}
  .tablewrap{overflow-x:auto;}
</style>
</head>
<body>
  <a class="back" href="/admin">&larr; 回一般預約總覽</a>
  <h1>麗波永康國際診所｜胸型重塑評估表單留資</h1>
  <div class="refresh">每 30 秒自動更新一次</div>
  <div id="content">載入中...</div>
  <script>
    const timeSlotLabel = {
      A: '上午 10:00-12:00',
      B: '中午 12:00-14:00',
      C: '下午 14:00-18:00',
      D: '晚上 18:00-20:00',
      E: '皆可/其他',
    };
    async function load() {
      try {
        const res = await fetch('/api/admin/consultations');
        const data = await res.json();
        const rows = data.consultations || [];
        if (rows.length === 0) {
          document.getElementById('content').innerHTML = '<div class="empty">目前沒有任何留資</div>';
          return;
        }
        let html = '<div class="tablewrap"><table><thead><tr>' +
          '<th>建立時間</th><th>姓名</th><th>電話</th><th>身高/體重</th><th>運動習慣</th><th>曾手術</th><th>體態型態</th><th>方便回電日期</th><th>方便時段</th><th>備註</th>' +
          '</tr></thead><tbody>';
        rows.forEach(r => {
          const slots = (r.preferred_time_slots || '').split(',').filter(Boolean)
            .map(s => timeSlotLabel[s] || s).join('、');
          html += '<tr>' +
            '<td>' + r.created_at + '</td>' +
            '<td>' + r.name + '</td>' +
            '<td>' + r.phone + '</td>' +
            '<td>' + (r.height || '-') + ' / ' + (r.weight || '-') + '</td>' +
            '<td>' + (r.exercise_habit || '') + '</td>' +
            '<td>' + (r.prior_surgery || '') + '</td>' +
            '<td>' + (r.body_type || '') + '</td>' +
            '<td>' + (r.preferred_date || '未指定') + '</td>' +
            '<td>' + slots + '</td>' +
            '<td>' + (r.note || '') + '</td>' +
            '</tr>';
        });
        html += '</tbody></table></div>';
        document.getElementById('content').innerHTML = html;
      } catch (err) {
        document.getElementById('content').innerHTML = '<div class="empty">載入失敗，請重新整理</div>';
      }
    }
    load();
    setInterval(load, 30000);
  </script>
</body>
</html>`);
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
