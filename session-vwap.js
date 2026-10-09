(function (root, factory) {
  "use strict";
  const api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (root) root.OptionDeskSessionVwap = api;
})(typeof globalThis === "undefined" ? null : globalThis, function () {
  "use strict";

  const OPEN_MINUTE = 9 * 60 + 30;
  const CLOSE_MINUTE = 16 * 60;
  const clock = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hourCycle: "h23"
  });

  function sessionTime(seconds) {
    if (!Number.isFinite(seconds)) return null;
    const parts = Object.fromEntries(clock.formatToParts(new Date(seconds * 1000))
      .filter((part) => part.type !== "literal").map((part) => [part.type, part.value]));
    return { date: `${parts.year}-${parts.month}-${parts.day}`, minute: Number(parts.hour) * 60 + Number(parts.minute) };
  }

  function unavailable(reason) { return { ready: false, reason, value: null, byTime: {} }; }

  function calculate(bars, sessionKey) {
    if (!Array.isArray(bars) || !/^\d{4}-\d{2}-\d{2}$/.test(String(sessionKey || ""))) {
      return unavailable("รอแท่ง 1m ของวันตลาดนี้");
    }
    const rows = bars.map((bar) => ({ bar, session: sessionTime(bar?.time) }))
      .filter(({ session }) => session?.date === sessionKey && session.minute >= OPEN_MINUTE && session.minute < CLOSE_MINUTE);
    if (!rows.length || rows[0].session.minute !== OPEN_MINUTE) return unavailable("แท่งตั้งแต่เปิดตลาด 9:30 ยังไม่ครบ");

    let expectedMinute = OPEN_MINUTE;
    let priceVolume = 0;
    let totalVolume = 0;
    const byTime = {};
    for (const { bar, session } of rows) {
      if (session.minute !== expectedMinute || bar.time % 60 !== 0) return unavailable("แท่ง 1m วันนี้ขาดช่วง");
      if (![bar.high, bar.low, bar.close, bar.volume].every(Number.isFinite)
        || bar.high < bar.low || bar.close <= 0 || bar.volume <= 0) return unavailable("volume หรือราคาหุ้นไม่ครบ");
      const typicalPrice = (bar.high + bar.low + bar.close) / 3;
      priceVolume += typicalPrice * bar.volume;
      totalVolume += bar.volume;
      byTime[bar.time] = priceVolume / totalVolume;
      expectedMinute += 1;
    }
    return { ready: true, reason: "", value: priceVolume / totalVolume, byTime, asOf: rows.at(-1).bar.time, bars: rows.length };
  }

  function check(vwap, direction, bar) {
    if (!vwap?.ready) return { ok: false, reason: vwap?.reason || "รอข้อมูล VWAP", value: null };
    if (!bar || !["up", "down"].includes(direction)) return { ok: false, reason: "รอทิศทาง CALL/PUT", value: vwap.value };
    const value = vwap.byTime[bar.time];
    if (!Number.isFinite(value) || !Number.isFinite(bar.close)) return { ok: false, reason: "VWAP ไม่ตรงกับแท่งล่าสุด", value: null };
    const ok = direction === "up" ? bar.close > value : bar.close < value;
    return { ok, reason: ok ? "ผ่าน" : direction === "up" ? "ราคายังไม่อยู่เหนือ VWAP" : "ราคายังไม่อยู่ใต้ VWAP", value };
  }

  return { calculate, check, sessionTime };
});
