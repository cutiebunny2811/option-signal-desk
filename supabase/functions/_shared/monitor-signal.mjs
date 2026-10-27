const lengths = { M1: 60, M5: 300, M15: 900 };

function ema(values, period) {
  const result = [];
  const weight = 2 / (period + 1);
  for (const value of values) result.push(result.length ? value * weight + result.at(-1) * (1 - weight) : value);
  return result.at(-1);
}

function rsi(values, period = 14) {
  if (values.length <= period) return null;
  let gain = 0, loss = 0;
  for (let i = 1; i <= period; i++) {
    const change = values[i] - values[i - 1];
    gain += Math.max(change, 0);
    loss += Math.max(-change, 0);
  }
  gain /= period; loss /= period;
  for (let i = period + 1; i < values.length; i++) {
    const change = values[i] - values[i - 1];
    gain = (gain * (period - 1) + Math.max(change, 0)) / period;
    loss = (loss * (period - 1) + Math.max(-change, 0)) / period;
  }
  return loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
}

function normalizeBars(input) {
  if (!Array.isArray(input)) return [];
  const seen = new Map();
  for (const bar of input) {
    const time = Date.parse(bar?.time);
    const open = Number(bar?.open), high = Number(bar?.high), low = Number(bar?.low), close = Number(bar?.close);
    if (![time, open, high, low, close].every(Number.isFinite) || close <= 0 || high < low) continue;
    seen.set(Math.floor(time / 1000), { time: Math.floor(time / 1000), open, high, low, close });
  }
  return [...seen.values()].sort((a, b) => a.time - b.time);
}

function aggregate(input, minutes) {
  const groups = new Map();
  for (const bar of input) {
    const bucket = Math.floor(bar.time / (minutes * 60)) * minutes * 60;
    if (!groups.has(bucket)) groups.set(bucket, []);
    groups.get(bucket).push(bar);
  }
  return [...groups].filter(([, rows]) => rows.length === minutes)
    .map(([time, rows]) => ({ time, close: rows.at(-1).close }));
}

function trend(bars, frame, now) {
  const last = bars.at(-1);
  const closeTime = last ? (last.time + lengths[frame]) * 1000 : 0;
  if (bars.length < 25 || !closeTime || now - closeTime > { M1: 4, M5: 8, M15: 18 }[frame] * 60_000) {
    return { direction: "wait", usable: false, closeTime };
  }
  const closes = bars.map((bar) => bar.close);
  const fast = ema(closes, 9), slow = ema(closes, 21), strength = rsi(closes);
  if (strength !== null && last.close > fast && fast > slow && strength >= 50) return { direction: "up", usable: true, closeTime };
  if (strength !== null && last.close < fast && fast < slow && strength < 50) return { direction: "down", usable: true, closeTime };
  return { direction: "wait", usable: true, closeTime };
}

export function assessChart(chart, now = Date.now()) {
  const fetched = Date.parse(chart?.fetched_at || "");
  if (!Number.isFinite(fetched) || chart?.stale) return { direction: "wait", tier: "wait", fresh: false, price: null, asOf: 0 };
  const observed = Math.min(fetched, now) - 3000;
  const minute = normalizeBars(chart.bars).filter((bar) => (bar.time + 60) * 1000 <= observed);
  const trends = {
    M1: trend(minute, "M1", now),
    M5: trend(aggregate(minute, 5), "M5", now),
    M15: trend(aggregate(minute, 15), "M15", now),
  };
  const fresh = trends.M1.usable && trends.M5.usable;
  let direction = "wait", tier = "wait";
  if (fresh && trends.M1.direction !== "wait" && trends.M1.direction === trends.M5.direction
    && (!trends.M15.usable || trends.M15.direction === "wait" || trends.M15.direction === trends.M1.direction)) {
    direction = trends.M1.direction;
    tier = trends.M15.usable && trends.M15.direction === direction ? "aligned" : "early";
  }
  return { direction, tier, fresh, price: minute.at(-1)?.close ?? null, asOf: trends.M1.closeTime };
}

export function shouldAlert(previous, next) {
  return Boolean(previous?.fresh && next?.fresh && previous.as_of > 0 && next.asOf > previous.as_of
    && ["up", "down"].includes(next.direction) && previous.direction !== next.direction);
}
