(function (root, factory) {
  "use strict";
  const api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (root) root.OptionDeskChartTime = api;
})(typeof globalThis === "undefined" ? null : globalThis, function () {
  "use strict";

  const lengths = { M1: 60, M5: 300, M15: 900, M60: 3600, M240: 14400 };
  const nyFormatter = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hourCycle: "h23"
  });
  const bkkClockFormatter = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Bangkok", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  const bkkDateFormatter = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Bangkok", day: "2-digit", month: "2-digit" });
  const bkkFullFormatter = new Intl.DateTimeFormat("th-TH", {
    timeZone: "Asia/Bangkok", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23"
  });

  function nyClock(milliseconds) {
    const parts = Object.fromEntries(nyFormatter.formatToParts(new Date(milliseconds))
      .filter((part) => part.type !== "literal").map((part) => [part.type, part.value]));
    return { date: `${parts.year}-${parts.month}-${parts.day}`, minutes: Number(parts.hour) * 60 + Number(parts.minute) };
  }

  function dailySessionKey(time) {
    const date = new Date(time * 1000);
    if (!Number.isFinite(date.getTime())) return null;
    // Webull date-only daily candles can arrive as UTC midnight; synthetic PCC day bars use noon UTC.
    return date.getUTCHours() === 0 && date.getUTCMinutes() === 0
      ? date.toISOString().slice(0, 10) : nyClock(date.getTime()).date;
  }

  function barEndMs(bar, frame) {
    if (!bar || !lengths[frame]) return null;
    const nominalEnd = (bar.time + lengths[frame]) * 1000;
    if (!["M60", "M240"].includes(frame)) return nominalEnd;
    const start = nyClock(bar.time * 1000);
    if (start.minutes < 9 * 60 + 30 || start.minutes >= 16 * 60) return nominalEnd;
    return Math.min(nominalEnd, bar.time * 1000 + (16 * 60 - start.minutes) * 60_000);
  }

  function completedBars(bars, frame, fetchedAt, now = Date.now()) {
    if (!Array.isArray(bars) || !(frame === "D" || lengths[frame])) return [];
    const fetchTime = new Date(fetchedAt || "").getTime();
    if (!Number.isFinite(fetchTime) || !Number.isFinite(now)) return [];
    // A cached intrabar snapshot never becomes a closed candle just because wall time advanced.
    const observedUntil = Math.min(fetchTime, now) - 3000;
    const observedClock = nyClock(observedUntil);
    return bars.filter((bar) => {
      if (!Number.isFinite(bar?.time)) return false;
      if (frame === "D") {
        const session = dailySessionKey(bar.time);
        return Boolean(session && (session < observedClock.date || session === observedClock.date && observedClock.minutes >= 16 * 60 + 10));
      }
      const end = barEndMs(bar, frame);
      if (end > observedUntil) return false;
      // A truncated last regular-session candle is only final after the settlement margin.
      if (end < (bar.time + lengths[frame]) * 1000) {
        const start = nyClock(bar.time * 1000);
        return start.date < observedClock.date || start.date === observedClock.date && observedClock.minutes >= 16 * 60 + 10;
      }
      return true;
    });
  }

  function formatBangkok(time) {
    const value = new Date(Number(time) * 1000);
    return Number.isFinite(value.getTime()) ? `${bkkFullFormatter.format(value)} น.` : "ไม่ทราบเวลา";
  }
  function formatSessionDate(time) {
    const key = dailySessionKey(Number(time));
    return key ? `${key.slice(8, 10)}/${key.slice(5, 7)}/${key.slice(0, 4)}` : "ไม่ทราบวัน";
  }
  function axisTick(time, tickType, daily = false) {
    const value = new Date(Number(time) * 1000);
    if (!Number.isFinite(value.getTime())) return null;
    if (daily) return formatSessionDate(time).slice(0, 5);
    if (tickType === 0) return new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Bangkok", year: "numeric" }).format(value);
    if (tickType === 1) return new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Bangkok", month: "2-digit", year: "2-digit" }).format(value);
    if (tickType === 2) return bkkDateFormatter.format(value);
    return bkkClockFormatter.format(value);
  }

  return { completedBars, barEndMs, dailySessionKey, formatBangkok, formatSessionDate, axisTick };
});
