// 診所看診時段規則：平日（週一～週五）09:00-18:00，每 30 分鐘一格
// 如需調整規則（例如加入週六、午休時間），只需修改這個檔案即可，其他程式碼不用動

const CLINIC_HOURS = {
  startHour: 9,
  endHour: 18,
  slotMinutes: 30,
  // 午休時間（不開放預約），格式 [開始, 結束)，可依實際狀況調整或設為 []
  lunchBreak: { start: '12:00', end: '13:30' },
  // 0 = 週日 ... 6 = 週六。目前僅平日看診
  openWeekdays: [1, 2, 3, 4, 5],
};

function pad(n) {
  return String(n).padStart(2, '0');
}

/**
 * 產生某一天所有的看診時段（不考慮是否已被預約）
 * @returns {string[]} 例如 ['09:00', '09:30', ... '17:30']
 */
function generateDailySlots() {
  const slots = [];
  const { startHour, endHour, slotMinutes, lunchBreak } = CLINIC_HOURS;
  let totalMinutes = startHour * 60;
  const endMinutes = endHour * 60;

  while (totalMinutes < endMinutes) {
    const h = Math.floor(totalMinutes / 60);
    const m = totalMinutes % 60;
    const timeStr = `${pad(h)}:${pad(m)}`;

    let inLunch = false;
    if (lunchBreak && lunchBreak.start && lunchBreak.end) {
      inLunch = timeStr >= lunchBreak.start && timeStr < lunchBreak.end;
    }
    if (!inLunch) {
      slots.push(timeStr);
    }
    totalMinutes += slotMinutes;
  }
  return slots;
}

/**
 * 檢查某日期字串 (YYYY-MM-DD) 是否為看診日
 */
function isClinicOpenOn(dateStr) {
  const d = new Date(`${dateStr}T00:00:00`);
  if (Number.isNaN(d.getTime())) return false;
  return CLINIC_HOURS.openWeekdays.includes(d.getDay());
}

module.exports = {
  CLINIC_HOURS,
  generateDailySlots,
  isClinicOpenOn,
};
