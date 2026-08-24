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
  a.tolink{font-size:13px;color:#1f6b5e;}
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
  <a class="tolink" href="/admin/consultations">查看胸型重塑評估表單留資 &rarr;</a>
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
