(function (root, factory) {
  "use strict";
  const api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (root) root.OptionDeskTradePlan = api;
})(typeof globalThis === "undefined" ? null : globalThis, function () {
  "use strict";

  const ARM_MINUTES = 30;
  const MAX_BAR_GAP_SECONDS = 240;
  const MAX_SPREAD_PERCENT = 10;
  const MIN_VOLUME = 10;
  const MIN_OPEN_INTEREST = 100;
  const QUOTE_MAX_AGE_MS = 5 * 60_000;
  const TERMINAL = new Set(["cancelled", "missed", "ambiguous", "data_gap", "session_end", "stopped", "tp2"]);
  const number = (value) => value === null || value === undefined || value === "" ? null : Number.isFinite(Number(value)) ? Number(value) : null;

  function contractCheck(contract, now) {
    const reasons = [];
    if (!contract) return { ok: false, reasons: ["ยังไม่ได้เลือกสัญญาฝั่งสัญญาณ"], spreadPercent: null };
    const bid = number(contract.bid), ask = number(contract.ask);
    const spreadPercent = bid !== null && ask !== null && ask + bid > 0 ? (ask - bid) / ((ask + bid) / 2) * 100 : null;
    if (bid === null || ask === null || bid <= 0 || ask < bid) reasons.push("bid/ask ใช้ไม่ได้");
    else if (spreadPercent > MAX_SPREAD_PERCENT) reasons.push(`spread เกิน ${MAX_SPREAD_PERCENT}%`);
    if ((number(contract.volume) || 0) < MIN_VOLUME) reasons.push(`volume ต่ำกว่า ${MIN_VOLUME}`);
    if ((number(contract.open_interest) || 0) < MIN_OPEN_INTEREST) reasons.push(`OI ต่ำกว่า ${MIN_OPEN_INTEREST}`);
    const quoteAt = Date.parse(contract.quote_time);
    if (!Number.isFinite(quoteAt) || now - quoteAt > QUOTE_MAX_AGE_MS || quoteAt - now > 60_000) reasons.push("quote เก่าหรือไม่มีเวลา");
    return { ok: reasons.length === 0, reasons, spreadPercent, quoteAt, symbol: contract.symbol || "" };
  }

  function beyond(price, level, direction) { return direction === "up" ? price >= level : price <= level; }
  function crossed(bar, level, direction) { return direction === "up" ? bar.high >= level && bar.close >= level : bar.low <= level && bar.close <= level; }
  function gapPast(bar, level, direction) { return beyond(bar.open, level, direction); }
  function terminal(plan, status, reason, at) { return { ...plan, status, reason, statusAt: at }; }

  function reconcile(previous, input) {
    const { symbol, sessionKey, candidate, confirmed, marketOpen, chartFresh, contract, bars, now } = input;
    const option = contractCheck(contract, now);
    const lastBar = bars?.at(-1);
    let plan = previous && previous.symbol === symbol && previous.sessionKey === sessionKey ? { ...previous } : null;

    if (plan && TERMINAL.has(plan.status)) {
      // A finished setup cannot silently re-arm from the same completed 5m candle.
      if (!candidate || candidate.basedOn <= plan.basedOn || !confirmed || !option.ok || !chartFresh || !marketOpen) return { plan, option };
      plan = null;
    }
    if (plan) {
      if (!marketOpen) return { plan: terminal(plan, "session_end", "ตลาดปิด · หยุดติดตาม ไม่ใช่ผลการเทรด", now), option };
      if (!chartFresh || !lastBar) return { plan: terminal(plan, "data_gap", "กราฟไม่สด · ไม่ยืนยันสัญญาณย้อนหลัง", now), option };
      const newBars = bars.filter((bar) => bar.time > plan.lastSeenBarTime);
      if (newBars.length && newBars[0].time - plan.lastSeenBarTime > MAX_BAR_GAP_SECONDS) {
        return { plan: terminal(plan, "data_gap", "แท่ง 1m ขาดช่วง · ไม่เดาว่าเกิดอะไรก่อน", now), option };
      }
      if (plan.status === "armed" && (!confirmed || !option.ok || contract?.symbol !== plan.contractSymbol)) {
        return { plan: terminal(plan, "cancelled", !confirmed ? "แนวโน้ม 4/4 หลุด" : "สัญญาหรือ quote ไม่ผ่านเกณฑ์", now), option };
      }
      for (const bar of newBars) {
        if (bar.time - plan.lastSeenBarTime > MAX_BAR_GAP_SECONDS) return { plan: terminal(plan, "data_gap", "แท่ง 1m ขาดช่วง", now), option };
        if (plan.status === "armed" && (bar.time + 60) * 1000 > plan.expiresAt) {
          return { plan: terminal(plan, "missed", "หมดเวลาเฝ้า 30 นาที", plan.expiresAt), option };
        }
        const observedAt = (bar.time + 60) * 1000;
        plan.lastSeenBarTime = bar.time;
        if (plan.status === "armed") {
          const stopTouched = plan.direction === "up" ? bar.low <= plan.stop : bar.high >= plan.stop;
          const entryTouched = plan.direction === "up" ? bar.high >= plan.entry : bar.low <= plan.entry;
          if (stopTouched && entryTouched) return { plan: terminal(plan, "ambiguous", "Entry และ SL อยู่ในแท่งเดียวกัน · ลำดับไม่ชัด", observedAt), option };
          if (stopTouched) return { plan: terminal(plan, "cancelled", "ราคาหุ้นแตะ SL ก่อน Entry", observedAt), option };
          if (gapPast(bar, plan.entry, plan.direction)) return { plan: terminal(plan, "missed", "เปิดแท่งเลย Entry · ไม่ไล่ราคา", bar.time * 1000), option };
          if (crossed(bar, plan.entry, plan.direction)) {
            const targetTouched = beyond(plan.direction === "up" ? bar.high : bar.low, plan.tp1, plan.direction);
            if (targetTouched) return { plan: terminal(plan, "missed", "ราคาแตะ TP1 ก่อนแท่งยืนยันปิด · ไม่ย้อนหลังจุดเข้า", observedAt), option };
            const overshoot = plan.direction === "up" ? bar.close - plan.entry : plan.entry - bar.close;
            if (overshoot > .25 * plan.risk) return { plan: terminal(plan, "missed", "แท่งยืนยันปิดเลย Entry มากกว่า 0.25R", observedAt), option };
            plan = { ...plan, status: "triggered", statusAt: observedAt, triggeredAt: observedAt, triggerClose: bar.close,
              detectedQuote: { bid: number(contract.bid), ask: number(contract.ask), quoteAt: option.quoteAt, spreadPercent: option.spreadPercent }
            };
          }
        } else if (["triggered", "tp1"].includes(plan.status)) {
          const stopTouched = plan.direction === "up" ? bar.low <= plan.stop : bar.high >= plan.stop;
          const tp2Touched = beyond(plan.direction === "up" ? bar.high : bar.low, plan.tp2, plan.direction);
          const tp1Touched = beyond(plan.direction === "up" ? bar.high : bar.low, plan.tp1, plan.direction);
          if (stopTouched && (tp1Touched || tp2Touched)) return { plan: terminal(plan, "ambiguous", "TP และ SL อยู่ในแท่งเดียวกัน · ลำดับไม่ชัด", observedAt), option };
          if (stopTouched) return { plan: terminal(plan, "stopped", "ราคาหุ้นแตะ SL · ไม่ใช่ผล P/L ของ Option", observedAt), option };
          if (tp2Touched) return { plan: terminal(plan, "tp2", "ราคาหุ้นแตะ TP2 · ตรวจผลสัญญาจริงแยก", observedAt), option };
          if (tp1Touched && plan.status !== "tp1") plan = { ...plan, status: "tp1", statusAt: observedAt };
        }
      }
      if (plan.status === "armed" && now >= plan.expiresAt) return { plan: terminal(plan, "missed", "หมดเวลาเฝ้า 30 นาที", plan.expiresAt), option };
      return { plan, option };
    }

    if (!candidate || !confirmed || !marketOpen || !chartFresh || !option.ok || !lastBar || candidate.wideRisk) return { plan: null, option };
    const completedFiveEnd = candidate.basedOn + 300;
    if (bars.some((bar) => bar.time >= completedFiveEnd && (candidate.direction === "up" ? bar.high >= candidate.entry : bar.low <= candidate.entry))) {
      return { plan: null, option, block: "ระดับ Entry ถูกแตะไปแล้วในแท่ง 1m ล่าสุด · รอ setup 5m ใหม่" };
    }
    if (candidate.direction === "up" ? lastBar.close >= candidate.entry : lastBar.close <= candidate.entry) {
      return { plan: null, option, block: "ราคาเลย Entry แล้ว · รอ setup 5m ใหม่ ไม่ไล่ราคา" };
    }
    return { plan: {
      ...candidate, symbol, sessionKey, contractSymbol: contract.symbol, status: "armed", reason: "",
      createdAt: now, expiresAt: now + ARM_MINUTES * 60_000, statusAt: now,
      lastSeenBarTime: lastBar.time
    }, option };
  }

  return { contractCheck, reconcile, MAX_SPREAD_PERCENT, MIN_VOLUME, MIN_OPEN_INTEREST };
});
