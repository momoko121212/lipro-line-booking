// LINE Messaging API 整合（預留介面）
//
// 目前 LINE_CHANNEL_ACCESS_TOKEN / LINE_CHANNEL_SECRET 尚未申請，
// 所以這裡的函式在沒有金鑰時會「安全地跳過」（只印出 log），
// 不會讓整個系統壞掉。等您申請好 LINE Messaging API Channel、
// 把金鑰填進 .env 之後，這裡就會自動開始真正發送訊息，不需要改任何程式碼。

const CHANNEL_ACCESS_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN || '';
const CHANNEL_SECRET = process.env.LINE_CHANNEL_SECRET || '';

const isConfigured = Boolean(CHANNEL_ACCESS_TOKEN && CHANNEL_SECRET);

/**
 * 預約成功後，推播訊息通知該 LINE 使用者
 * @param {string} lineUserId - 使用者的 LINE userId（透過 LIFF 取得）
 * @param {string} text - 要發送的訊息內容
 */
async function pushMessage(lineUserId, text) {
  if (!isConfigured) {
    console.log('[LINE] 尚未設定 Channel Access Token，略過推播。訊息內容：', text);
    return { skipped: true };
  }
  if (!lineUserId) {
    console.log('[LINE] 沒有 lineUserId（可能是非 LIFF 環境的一般網頁預約），略過推播。');
    return { skipped: true };
  }

  const res = await fetch('https://api.line.me/v2/bot/message/push', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${CHANNEL_ACCESS_TOKEN}`,
    },
    body: JSON.stringify({
      to: lineUserId,
      messages: [{ type: 'text', text }],
    }),
  });

  if (!res.ok) {
    const errBody = await res.text();
    console.error('[LINE] 推播失敗：', res.status, errBody);
    return { skipped: false, ok: false, error: errBody };
  }
  return { skipped: false, ok: true };
}

module.exports = {
  isConfigured,
  pushMessage,
  CHANNEL_SECRET,
};
