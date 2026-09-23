(() => {
  "use strict";

  const config = window.__OPTION_DESK_CONFIG__;
  const priceLevels = window.OptionDeskLevels;
  const demo = ["localhost", "127.0.0.1"].includes(location.hostname) && new URLSearchParams(location.search).get("preview") === "1";
  const $ = (selector) => document.querySelector(selector);
  const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]);
  const numeric = (value) => value === null || value === undefined || value === "" ? null : Number.isFinite(Number(value)) ? Number(value) : null;
  const money = (value, decimals = 2) => numeric(value) === null ? "—" : `$${Number(value).toLocaleString("en-US", { minimumFractionDigits: decimals, maximumFractionDigits: decimals })}`;
  const strikeMoney = (value) => numeric(value) === null ? "—" : `$${Number(value).toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
  const count = (value) => numeric(value) === null ? "—" : Number(value).toLocaleString("en-US", { maximumFractionDigits: 0 });
  const signedPercent = (value) => numeric(value) === null ? "" : `${Number(value) >= 0 ? "+" : ""}${Number(value).toFixed(2)}%`;
  const bkkTime = (value) => {
    const date = new Date(value);
    return Number.isFinite(date.getTime()) ? date.toLocaleString("th-TH", { timeZone: "Asia/Bangkok", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) + " น." : "ไม่ทราบเวลา";
  };
  const state = {
    db: null, user: null, watchlist: [], pulse: [], search: "", symbol: "", instrumentId: null,
    call: null, put: null, expiry: "", side: "call", contractSymbol: "", charts: {}, chartFrame: "M1",
    chart: null, resizeObserver: null, busy: false, requestId: 0, lastError: "",
    lastOptionAttemptAt: 0, lastChartAttemptAt: {}, lastWatchlistReadAt: 0,
    lastInteractionAt: Date.now(), lastManualAt: 0, quotaPauseUntil: 0, planDirection: "wait", levelSide: "auto"
  };

  const OPTION_POLL_MS = 3 * 60_000;
  const MINUTE_POLL_MS = 2 * 60_000;
  const HOUR_POLL_MS = 10 * 60_000;
  const IDLE_PAUSE_MS = 20 * 60_000;

  function marketOpenNow() {
    if (demo) return true;
    const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York", weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23"
    }).formatToParts(new Date()).filter((part) => part.type !== "literal").map((part) => [part.type, part.value]));
    const minutes = Number(parts.hour) * 60 + Number(parts.minute);
    return !["Sat", "Sun"].includes(parts.weekday) && minutes >= 570 && minutes < 960;
  }

  function setStatus(message = "", isError = false) {
    const line = $("#status-line");
    line.textContent = message;
    line.classList.toggle("error", isError);
  }

  const ema = (values, period) => priceLevels.ema(values, period);

  function normalizeBars(input) {
    if (!Array.isArray(input)) return [];
    const seen = new Map();
    for (const bar of input) {
      const time = Date.parse(bar?.time);
      const open = numeric(bar?.open), high = numeric(bar?.high), low = numeric(bar?.low), close = numeric(bar?.close);
      if (![time, open, high, low, close].every(Number.isFinite) || close <= 0 || high < low) continue;
      seen.set(Math.floor(time / 1000), { time: Math.floor(time / 1000), open, high, low, close, volume: numeric(bar?.volume) || 0 });
    }
    return [...seen.values()].sort((a, b) => a.time - b.time);
  }

  function closedBars(input, minutes) {
    const cutoff = Date.now() / 1000 - 3;
    return normalizeBars(input).filter((bar) => bar.time + minutes * 60 <= cutoff);
  }

  function aggregateBars(input, minutes) {
    const groups = new Map();
    for (const bar of closedBars(input, 1)) {
      const bucket = Math.floor(bar.time / (minutes * 60)) * minutes * 60;
      if (!groups.has(bucket)) groups.set(bucket, []);
      groups.get(bucket).push(bar);
    }
    return [...groups].filter(([, rows]) => rows.length === minutes).map(([time, rows]) => ({
      time, open: rows[0].open, high: Math.max(...rows.map((row) => row.high)),
      low: Math.min(...rows.map((row) => row.low)), close: rows.at(-1).close,
      volume: rows.reduce((sum, row) => sum + row.volume, 0)
    }));
  }

  function barsFor(frame) {
    if (frame === "M5") return aggregateBars(state.charts.M1?.bars, 5);
    if (frame === "M15") return aggregateBars(state.charts.M1?.bars, 15);
    return closedBars(state.charts[frame]?.bars, frame === "M60" ? 60 : 1);
  }

  function sourceFor(frame) { return state.charts[["M5", "M15"].includes(frame) ? "M1" : frame]; }

  function rsi(values, period = 14) {
    if (values.length <= period) return null;
    let gain = 0, loss = 0;
    for (let index = 1; index <= period; index += 1) {
      const change = values[index] - values[index - 1];
      gain += Math.max(change, 0); loss += Math.max(-change, 0);
    }
    gain /= period; loss /= period;
    for (let index = period + 1; index < values.length; index += 1) {
      const change = values[index] - values[index - 1];
      gain = (gain * (period - 1) + Math.max(change, 0)) / period;
      loss = (loss * (period - 1) + Math.max(-change, 0)) / period;
    }
    return loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
  }

  function technicalTrend(bars) {
    if (bars.length < 25) return { direction: "wait", label: "รอข้อมูล", detail: "แท่งราคาไม่พอ" };
    const closes = bars.map((bar) => bar.close);
    const fast = ema(closes, 9).at(-1), slow = ema(closes, 21).at(-1), last = closes.at(-1);
    const strength = rsi(closes);
    const rsiLabel = strength === null ? "RSI —" : `RSI ${Math.round(strength)}`;
    if (strength !== null && last > fast && fast > slow && strength >= 50) return { direction: "up", label: "ขึ้น", detail: `${rsiLabel} · EMA ขึ้น`, usable: true };
    if (strength !== null && last < fast && fast < slow && strength < 50) return { direction: "down", label: "ลง", detail: `${rsiLabel} · EMA ลง`, usable: true };
    return { direction: "wait", label: "รอ", detail: `${rsiLabel} · ยังไม่ตรง`, usable: true };
  }

  function trendFor(frame) {
    const bars = barsFor(frame);
    if (bars.length < 25) return { direction: "wait", label: "รอข้อมูล", detail: "แท่งราคาไม่พอ" };
    if (!marketOpenNow()) return { direction: "wait", label: "ตลาดปิด", detail: "ไม่คอนเฟิร์มนอกเวลาตลาด", closed: true };
    const duration = { M1: 1, M5: 5, M15: 15, M60: 60 }[frame] || 60;
    // A completed higher-timeframe candle stays valid until its successor closes.
    // Give each frame one full candle plus a small provider/cache arrival margin.
    const maxLag = { M1: 4, M5: 8, M15: 18, M60: 65 }[frame] || 65;
    if (sourceFor(frame)?.stale || Date.now() - (bars.at(-1).time + duration * 60) * 1000 > maxLag * 60_000) {
      return { direction: "wait", label: "ข้อมูลเก่า", detail: "รอแท่งราคาใหม่", stale: true };
    }
    return technicalTrend(bars);
  }

  function renderWatchlist() {
    const rows = state.watchlist.filter((item) => item.symbol.includes(state.search));
    const prices = new Map(state.pulse.map((row) => [String(row.symbol).toUpperCase(), row]));
    $("#watch-list").innerHTML = rows.length ? rows.map((item) => {
      const quote = prices.get(item.symbol);
      return `<button class="watch-item ${item.symbol === state.symbol ? "active" : ""}" type="button" data-symbol="${esc(item.symbol)}" aria-pressed="${item.symbol === state.symbol}"><strong>${esc(item.symbol)}</strong><span class="watch-price">${money(quote?.price)}</span><small>${esc(item.name || "หุ้นใน PCC")}</small></button>`;
    }).join("") : `<p class="empty-list">${state.search ? "ไม่พบ ticker ที่ค้นหา" : "ยังไม่มีหุ้นใน watchlist"}</p>`;
  }

  function renderHeader() {
    const underlying = state.call?.underlying || state.put?.underlying || null;
    const price = underlying?.price;
    const change = underlying?.change_percent;
    $("#symbol-title").textContent = state.symbol || "—";
    $("#spot-price").textContent = money(price);
    $("#spot-change").textContent = signedPercent(change);
    $("#spot-change").className = `ticker-change ${numeric(change) === null ? "" : Number(change) >= 0 ? "positive" : "negative"}`;
    $("#spot-time").textContent = underlying ? `ราคาหุ้น ณ ${bkkTime(underlying.market_time)} · ข้อมูล option ณ ${bkkTime(state.call?.fetched_at || state.put?.fetched_at)}` : state.busy ? "กำลังโหลดข้อมูล" : "เลือกหุ้นเพื่อดูข้อมูล";
    $("#symbol-input").value = state.symbol;
    $("#refresh-button").disabled = state.busy || !state.symbol;
    const badge = $("#source-pill");
    badge.textContent = demo ? "DEMO / ข้อมูลตัวอย่าง" : state.call || state.put ? "WEBULL OPRA" : "รอข้อมูล";
    badge.className = `source-pill ${demo ? "demo" : state.call || state.put ? "live" : ""}`;
    $("#market-status").textContent = demo ? "โหมดตัวอย่าง" : state.busy ? "กำลังอ่านข้อมูล" : state.call || state.put ? "เชื่อม PCC แล้ว" : "รอข้อมูล";
    $("#market-status").classList.toggle("is-demo", demo);
  }

  function renderSignals() {
    const frames = [["M1", "1m"], ["M5", "5m"], ["M15", "15m"], ["M60", "1h"]];
    const trends = frames.map(([frame, label]) => ({ ...trendFor(frame), frame, frameLabel: label }));
    $("#signal-grid").innerHTML = trends.map((trend) => `<div class="signal-card"><small>${trend.frameLabel}</small><strong class="${trend.direction}">${trend.label}</strong><span>${esc(trend.detail)}</span></div>`).join("");
    const up = trends.filter((trend) => trend.direction === "up").length;
    const down = trends.filter((trend) => trend.direction === "down").length;
    const loaded = trends.filter((trend) => trend.usable).length;
    const stale = trends.filter((trend) => trend.stale).length;
    const verdict = $("#signal-verdict");
    let message = "รอข้อมูลกราฟ", detail = "ยังประเมินแนวโน้มไม่ได้", tone = "wait";
    if (!marketOpenNow()) { message = "ตลาดสหรัฐฯ ปิด"; detail = "สัญญาณ 4 ช่วงเวลาจะคอนเฟิร์มเฉพาะช่วงตลาดเปิด"; }
    else if (stale > 0) { message = "รอแท่งราคาใหม่"; detail = `${stale} ช่วงเวลาเก่า · ไม่ใช้ยืนยันสัญญาณ`; }
    else if (loaded === 4 && up === 4) { message = "แนวโน้มขึ้นตรงกัน 4/4"; detail = "เฝ้าดู CALL · ยังต้องเช็กจุดเข้าและสัญญา"; tone = "up"; }
    else if (loaded === 4 && down === 4) { message = "แนวโน้มลงตรงกัน 4/4"; detail = "เฝ้าดู PUT · ยังต้องเช็กจุดเข้าและสัญญา"; tone = "down"; }
    else if (loaded > 0) { message = "ยังไม่คอนเฟิร์ม"; detail = `${up} ขึ้น · ${down} ลง · ${4 - up - down} รอ`; }
    verdict.className = `signal-verdict ${tone}`;
    verdict.innerHTML = `<span>${message}</span><small>${detail}</small>`;
    const quoteFresh = (side) => {
      const quoteTimes = contracts(side).map((item) => new Date(item.quote_time).getTime()).filter(Number.isFinite);
      return quoteTimes.length > 0 && Date.now() - Math.max(...quoteTimes) < 5 * 60_000;
    };
    const callReady = tone === "up" && quoteFresh("call");
    const putReady = tone === "down" && quoteFresh("put");
    state.planDirection = callReady ? "up" : putReady ? "down" : "wait";
    $("#option-signal").innerHTML = `<div class="option-lane ${callReady ? "active call" : ""}"><span>CALL / ฝั่งขึ้น</span><strong>${callReady ? "เฝ้าดู" : "WAIT"}</strong><small>${callReady ? "4/4 ตรง · quote ไม่เก่า" : "ยังไม่ครบเงื่อนไข"}</small></div><div class="option-lane ${putReady ? "active put" : ""}"><span>PUT / ฝั่งลง</span><strong>${putReady ? "เฝ้าดู" : "WAIT"}</strong><small>${putReady ? "4/4 ตรง · quote ไม่เก่า" : "ยังไม่ครบเงื่อนไข"}</small></div>`;
  }

  function levelState() {
    const bars = barsFor("M5");
    const indicators = priceLevels.describe(bars);
    const source = sourceFor("M5");
    const last = bars.at(-1);
    const fresh = Boolean(last && !source?.stale && marketOpenNow() && Date.now() - (last.time + 300) * 1000 <= 8 * 60_000);
    const recentHistory = Boolean(last && Date.now() - (last.time + 300) * 1000 < 4 * 24 * 60 * 60_000);
    const five = technicalTrend(bars).direction;
    const fifteen = technicalTrend(barsFor("M15")).direction;
    const watchDirection = five === fifteen && five !== "wait" ? five : "wait";
    const direction = state.levelSide === "call" ? "up" : state.levelSide === "put" ? "down"
      : state.planDirection !== "wait" ? state.planDirection : watchDirection;
    const plan = recentHistory && direction !== "wait" ? priceLevels.calculate(bars, direction) : null;
    const livePlan = Boolean(plan && !plan.wideRisk && fresh && state.planDirection === direction);
    return { indicators, plan, fresh, source, livePlan, recentHistory };
  }

  function renderLevels() {
    const { indicators, plan, fresh, source, livePlan, recentHistory } = levelState();
    const status = $("#level-status");
    for (const button of $("#level-side").querySelectorAll("button")) {
      const selected = button.dataset.levelSide === state.levelSide;
      button.classList.toggle("active", selected);
      button.setAttribute("aria-pressed", String(selected));
    }
    $(".level-panel").classList.toggle("preview", Boolean(plan && !livePlan));
    status.className = livePlan ? `level-ready ${plan.direction}` : "level-wait";
    status.textContent = livePlan ? `เฝ้าดู ${plan.direction === "up" ? "CALL" : "PUT"} · 1R = ${money(plan.risk)}`
      : plan?.wideRisk ? `WAIT · 1R กว้างกว่า 3 ATR (${money(plan.risk)})`
      : plan && !marketOpenNow() ? `WAIT · ตลาดปิด · ระดับ${plan.direction === "up" ? "CALL" : "PUT"} จากรอบก่อน`
      : plan ? `WAIT · ระดับ${plan.direction === "up" ? "CALL" : "PUT"} ยังไม่คอนเฟิร์ม 4/4`
      : !marketOpenNow() ? "WAIT · ตลาดปิด"
      : !recentHistory ? "WAIT · ไม่มีแท่งล่าสุดใน 4 วัน"
      : source?.stale || !fresh ? "WAIT · รอแท่ง 5m ใหม่"
      : "WAIT · เลือก CALL/PUT เพื่อดูระดับจำลอง";
    const cells = [
      ["Forecast* +15m", fresh ? indicators?.projection : null, "forecast"],
      ["EMA9 · 5m", indicators?.ema9, "ema-fast"],
      ["EMA21 · 5m", indicators?.ema21, "ema-slow"],
      [`Entry ${plan?.direction === "down" ? "PUT" : plan?.direction === "up" ? "CALL" : ""}`, plan?.entry, "entry"],
      ["SL · จุดยกเลิก", plan?.stop, "stop"],
      ["TP1 · 1R", plan?.tp1, "target"],
      ["TP2 · 1.8R", plan?.tp2, "target"],
      ["1R · ระยะเสี่ยง", plan?.risk, "risk"]
    ];
    $("#level-grid").innerHTML = cells.map(([label, value, tone]) => `<div class="level-cell ${tone}"><small>${esc(label)}</small><strong>${money(value)}</strong></div>`).join("");
    $("#level-note").textContent = indicators
      ? `อ้างอิงแท่ง 5m ปิดล่าสุด ${bkkTime(new Date((indicators.basedOn + 300) * 1000))} · ${livePlan ? "แผนเฝ้าดูสด" : "ระดับอ้างอิงย้อนหลัง ไม่ใช่สัญญาณสด"} · ราคาหุ้น ไม่ใช่ option premium · Forecast* เป็นเพียงการลากแนว EMA ต่อ`
      : "รอแท่ง 5m ให้พอคำนวณ · ระดับทั้งหมดอ้างอิงราคาหุ้น ไม่ใช่ราคา premium ของ option";
  }

  function renderDataStatus() {
    const open = marketOpenNow();
    const idle = Date.now() - state.lastInteractionAt > IDLE_PAUSE_MS;
    const paused = Date.now() < state.quotaPauseUntil;
    $("#refresh-policy").textContent = demo ? "ข้อมูลตัวอย่างในเครื่อง" : paused ? "พักการดึงข้อมูลหลังพบข้อจำกัด API" : !open ? "ตลาดสหรัฐฯ ปิด · หยุดรีเฟรชอัตโนมัติ" : document.hidden || idle ? "พักอัตโนมัติ · กลับมาที่แท็บเพื่ออัปเดต" : "ติดตามอัตโนมัติ · กราฟ 2 นาที / Option 3 นาที";
    const quoteTimes = [...contracts("call"), ...contracts("put")].map((item) => new Date(item.quote_time).getTime()).filter(Number.isFinite);
    $("#option-freshness").textContent = quoteTimes.length ? `Option quote ${bkkTime(new Date(Math.max(...quoteTimes)))}` : "Option quote —";
    const minute = state.charts.M1;
    $("#minute-freshness").textContent = minute?.fetched_at ? `กราฟ 1m ${minute.stale ? "แคชเก่า" : "อ่านเมื่อ"} ${bkkTime(minute.fetched_at)}` : "กราฟ 1m —";
  }

  function clearChart() {
    state.resizeObserver?.disconnect();
    state.resizeObserver = null;
    state.chart?.remove();
    state.chart = null;
  }

  function renderChart() {
    const container = $("#price-chart");
    clearChart();
    container.replaceChildren();
    const data = sourceFor(state.chartFrame);
    const bars = barsFor(state.chartFrame);
    $("#chart-freshness").textContent = data?.fetched_at ? `${data.stale ? "แคชเก่า" : data.cached ? "จากแคช" : "อัปเดต"} · ${bkkTime(data.fetched_at)}` : "ยังไม่มีข้อมูล";
    for (const button of $("#chart-frames").querySelectorAll("button")) button.classList.toggle("active", button.dataset.frame === state.chartFrame);
    if (!bars.length) { container.innerHTML = `<div class="chart-empty">${state.busy ? "กำลังเปิดกราฟ…" : "ยังไม่มีกราฟสำหรับหุ้นนี้"}</div>`; return; }
    const library = window.LightweightCharts;
    if (!library?.createChart) { container.innerHTML = `<div class="chart-empty">กราฟโหลดไม่สำเร็จ กรุณารีเฟรชหน้า</div>`; return; }
    const chart = library.createChart(container, {
      width: container.clientWidth, height: container.clientHeight, layout: { background: { color: "#030405" }, textColor: "#b5bac0", fontFamily: "IBM Plex Mono, monospace", fontSize: 11 },
      grid: { vertLines: { color: "#1a1e21" }, horzLines: { color: "#1a1e21" } },
      rightPriceScale: { borderColor: "#34383d" }, timeScale: { borderColor: "#34383d", timeVisible: state.chartFrame !== "D" },
      crosshair: { vertLine: { color: "#d4af3777" }, horzLine: { color: "#d4af3777" } },
      handleScroll: { horzTouchDrag: true, vertTouchDrag: false }
    });
    const candles = chart.addSeries(library.CandlestickSeries, { upColor: "#27d98b", downColor: "#ff5363", borderVisible: false, wickUpColor: "#27d98b", wickDownColor: "#ff5363" });
    candles.setData(bars.map(({ time, open, high, low, close }) => ({ time, open, high, low, close })));
    const volume = chart.addSeries(library.HistogramSeries, { priceScaleId: "volume", priceFormat: { type: "volume" }, priceLineVisible: false, lastValueVisible: false });
    volume.setData(bars.map((bar) => ({ time: bar.time, value: bar.volume, color: bar.close >= bar.open ? "#27d98b66" : "#ff536366" })));
    chart.priceScale("volume").applyOptions({ visible: false, scaleMargins: { top: .83, bottom: 0 } });
    const closes = bars.map((bar) => bar.close);
    const frameLabel = { M1: "1m", M5: "5m", M15: "15m", M60: "1h", M240: "4h", D: "1D" }[state.chartFrame];
    [[9, "#4bd6eb"], [21, "#d4af37"]].forEach(([period, color]) => {
      const line = chart.addSeries(library.LineSeries, { color, lineWidth: 2, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false });
      const values = ema(closes, period);
      line.setData(bars.map((bar, index) => ({ time: bar.time, value: values[index] })));
      line.createPriceLine({ price: values.at(-1), color, lineWidth: 1, lineStyle: library.LineStyle?.Dotted ?? 1, axisLabelVisible: true, title: `EMA${period} ${frameLabel}` });
    });
    if (!["M240", "D"].includes(state.chartFrame)) {
      const { indicators, plan, fresh, livePlan } = levelState();
      const overlayPrices = [];
      const addLevel = (price, title, color, lineStyle = library.LineStyle?.Dashed ?? 2) => {
        candles.createPriceLine({ price, title, color, lineStyle, lineWidth: 1, axisLabelVisible: true });
        overlayPrices.push(price);
      };
      if (fresh && indicators) {
        addLevel(indicators.projection, "Forecast*", "#b58cff", library.LineStyle?.Dotted ?? 1);
        if (["M1", "M5", "M15"].includes(state.chartFrame)) {
          const startTime = Math.max(bars.at(-1).time, indicators.basedOn + 300);
          const projectionLine = chart.addSeries(library.LineSeries, { color: "#b58cff", lineStyle: library.LineStyle?.Dotted ?? 1, lineWidth: 2, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false });
          projectionLine.setData([{ time: startTime, value: indicators.ema9 }, { time: startTime + 900, value: indicators.projection }]);
        }
      }
      if (plan) {
        addLevel(plan.entry, "ENTRY", livePlan ? "#4bd6eb" : "#82949b");
        addLevel(plan.stop, "SL", livePlan ? "#ff5262" : "#98747b");
        addLevel(plan.tp1, "TP1", livePlan ? "#27db8c" : "#678f7a");
        addLevel(plan.tp2, "TP2", livePlan ? "#18ac71" : "#5d806e");
      }
      if (overlayPrices.length) {
        const scaleGuide = chart.addSeries(library.LineSeries, { color: "rgba(0, 0, 0, 0)", lineWidth: 1, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false });
        scaleGuide.setData([{ time: bars[0].time, value: Math.min(...overlayPrices) }, { time: bars.at(-1).time, value: Math.max(...overlayPrices) }]);
      }
    }
    const lookback = { M1: 180, M5: 100, M15: 80, M60: 80 }[state.chartFrame];
    const future = { M1: 18, M5: 4, M15: 2, M60: 1 }[state.chartFrame];
    if (lookback) chart.timeScale().setVisibleLogicalRange({ from: Math.max(0, bars.length - lookback), to: bars.length + future });
    else chart.timeScale().fitContent();
    state.chart = chart;
    state.resizeObserver = new ResizeObserver(() => chart.applyOptions({ width: container.clientWidth, height: container.clientHeight }));
    state.resizeObserver.observe(container);
  }

  function chain(side) { return side === "put" ? state.put : state.call; }
  function contracts(side) { return Array.isArray(chain(side)?.contracts) ? chain(side).contracts : []; }
  function mergedOiRows() {
    const rows = new Map();
    for (const side of ["call", "put"]) for (const contract of contracts(side)) {
      const strike = numeric(contract.strike);
      if (strike === null) continue;
      if (!rows.has(strike)) rows.set(strike, { strike, call: null, put: null });
      rows.get(strike)[side] = contract;
    }
    return [...rows.values()].sort((a, b) => a.strike - b.strike);
  }

  function renderExpiry() {
    const expiries = state.call?.expiries || state.put?.expiries || [];
    const select = $("#expiry-select");
    select.disabled = !expiries.length || state.busy;
    select.innerHTML = expiries.length ? expiries.map((item) => `<option value="${esc(item.value)}">${esc(item.value)} · ${count(item.dte)} DTE</option>`).join("") : `<option>รอข้อมูล</option>`;
    if (state.expiry) select.value = state.expiry;
  }

  function renderOi() {
    renderExpiry();
    const rows = mergedOiRows();
    const spot = numeric(state.call?.underlying?.price ?? state.put?.underlying?.price);
    const callTotal = rows.reduce((sum, row) => sum + (numeric(row.call?.open_interest) || 0), 0);
    const putTotal = rows.reduce((sum, row) => sum + (numeric(row.put?.open_interest) || 0), 0);
    const largestCall = rows.reduce((best, row) => (numeric(row.call?.open_interest) || 0) > (numeric(best?.call?.open_interest) || 0) ? row : best, null);
    const largestPut = rows.reduce((best, row) => (numeric(row.put?.open_interest) || 0) > (numeric(best?.put?.open_interest) || 0) ? row : best, null);
    $("#oi-summary").innerHTML = `<div><small>CALL OI รวม*</small><strong class="call">${count(callTotal)}</strong></div><div><small>PUT OI รวม*</small><strong class="put">${count(putTotal)}</strong></div><div><small>PUT / CALL OI*</small><strong>${callTotal ? (putTotal / callTotal).toFixed(2) : "—"}</strong></div>`;
    if (!rows.length) { $("#oi-rows").innerHTML = `<tr><td colspan="7" class="empty-panel">${state.busy ? "กำลังอ่าน option chain…" : "ยังไม่มีข้อมูล OI สำหรับหุ้นนี้"}</td></tr>`; return; }
    const maxOi = Math.max(...rows.flatMap((row) => [numeric(row.call?.open_interest) || 0, numeric(row.put?.open_interest) || 0]), 1);
    const nearest = spot === null ? null : rows.reduce((best, row) => Math.abs(row.strike - spot) < Math.abs((best?.strike ?? Infinity) - spot) ? row : best, null)?.strike;
    $("#oi-rows").innerHTML = rows.map((row) => {
      const callOi = numeric(row.call?.open_interest) || 0, putOi = numeric(row.put?.open_interest) || 0;
      return `<tr class="${row.strike === nearest ? "near" : ""}"><td class="oi-val"><button class="oi-pick" type="button" data-pick-side="call" data-pick-strike="${row.strike}" ${row.call ? "" : "disabled"}>${count(row.call?.open_interest)}</button></td><td class="bar-cell" colspan="2"><span class="oi-bar" style="width:${Math.max(callOi / maxOi * 100, callOi ? 2 : 0)}%"></span></td><td class="strike">${strikeMoney(row.strike)}</td><td class="bar-cell" colspan="2"><span class="oi-bar put" style="width:${Math.max(putOi / maxOi * 100, putOi ? 2 : 0)}%"></span></td><td class="oi-val"><button class="oi-pick" type="button" data-pick-side="put" data-pick-strike="${row.strike}" ${row.put ? "" : "disabled"}>${count(row.put?.open_interest)}</button></td></tr>`;
    }).join("");
    // These levels describe where OI is concentrated; they are not support/resistance predictions.
    state.oiLeaders = { call: largestCall?.strike ?? null, put: largestPut?.strike ?? null };
  }

  function renderContract() {
    for (const button of $("#option-side").querySelectorAll("button")) button.classList.toggle("active", button.dataset.side === state.side);
    const rows = [...contracts(state.side)].sort((a, b) => Math.abs(Number(a.strike) - Number(chain(state.side)?.underlying?.price)) - Math.abs(Number(b.strike) - Number(chain(state.side)?.underlying?.price)));
    if (!rows.some((row) => row.symbol === state.contractSymbol)) state.contractSymbol = rows[0]?.symbol || "";
    $("#contract-list").innerHTML = rows.length ? rows.map((row) => `<button class="contract-row ${row.symbol === state.contractSymbol ? "active" : ""}" type="button" data-contract="${esc(row.symbol)}"><strong>${strikeMoney(row.strike)} ${state.side.toUpperCase()}</strong><span class="contract-ask">ASK ${money(row.ask)}</span><small>Δ ${numeric(row.delta)?.toFixed(2) ?? "—"} · OI ${count(row.open_interest)} · VOL ${count(row.volume)}</small></button>`).join("") : `<div class="empty-panel">${state.busy ? "กำลังอ่านสัญญา…" : "ไม่มีข้อมูลสัญญาฝั่งนี้"}</div>`;
    const selected = rows.find((row) => row.symbol === state.contractSymbol);
    if (!selected) { $("#contract-detail").innerHTML = `<div class="empty-panel">เลือกสัญญาเพื่อดูรายละเอียด</div>`; $("#decision-note").innerHTML = ""; return; }
    const ask = numeric(selected.ask), bid = numeric(selected.bid), mid = ask !== null && bid !== null ? (ask + bid) / 2 : null;
    const spread = mid && ask !== null && bid !== null ? (ask - bid) / mid * 100 : null;
    const strike = numeric(selected.strike);
    const multiplier = numeric(selected.multiplier) || 100;
    const breakEven = ask !== null && strike !== null ? state.side === "call" ? strike + ask : strike - ask : null;
    const cost = ask === null ? null : ask * multiplier;
    const iv = numeric(selected.implied_volatility);
    $("#contract-detail").innerHTML = `<h3>${strikeMoney(strike)} ${state.side.toUpperCase()}</h3><span class="contract-code">${esc(selected.symbol)}</span><div class="contract-stat-lead"><div><small>BID / ASK</small><strong>${money(bid)} / ${money(ask)}</strong></div><div><small>SPREAD</small><strong>${spread === null ? "—" : spread.toFixed(1) + "%"}</strong></div></div><dl class="detail-grid"><div><dt>Delta</dt><dd>${numeric(selected.delta)?.toFixed(3) ?? "—"}</dd></div><div><dt>IV</dt><dd>${iv === null ? "—" : (iv * 100).toFixed(1) + "%"}</dd></div><div><dt>Volume / OI</dt><dd>${count(selected.volume)} / ${count(selected.open_interest)}</dd></div><div><dt>Theta / วัน</dt><dd>${numeric(selected.theta)?.toFixed(3) ?? "—"}</dd></div><div><dt>ต้นทุนที่ Ask</dt><dd>${money(cost, 0)}</dd></div><div><dt>คุ้มทุน ณ หมดอายุ</dt><dd>${money(breakEven)}</dd></div></dl>`;
    const warnings = [];
    if (spread === null) warnings.push("ไม่มี bid/ask ครบ จึงประเมิน spread ไม่ได้");
    else if (spread > 10) warnings.push(`spread ${spread.toFixed(1)}% ค่อนข้างกว้าง`);
    if ((numeric(selected.volume) || 0) < 10) warnings.push("volume วันนี้ต่ำ");
    if ((numeric(selected.open_interest) || 0) < 100) warnings.push("OI ต่ำกว่า 100 สัญญา");
    $("#decision-note").innerHTML = `<strong>เช็กก่อนเลือกสัญญา</strong><p>${warnings.length ? warnings.map(esc).join(" · ") : "bid/ask และสภาพคล่องเบื้องต้นอยู่ในช่วงที่อ่านค่าได้"}</p><p>ต้นทุนคำนวณจากราคา Ask × ${multiplier} · แผน Entry / TP / SL ใต้กราฟเป็นราคาหุ้น ไม่ใช่ option premium และยังไม่ผ่านการทดสอบย้อนหลัง</p><small>Quote ณ ${bkkTime(selected.quote_time || chain(state.side)?.fetched_at)}</small>`;
  }

  function renderAll() { renderWatchlist(); renderHeader(); renderSignals(); renderDataStatus(); renderChart(); renderLevels(); renderOi(); renderContract(); }

  async function edge(action, body) {
    const { data, error } = await state.db.functions.invoke("refresh-stock-prices", { body: { action, ...body } });
    if (error) {
      let detail = error.message;
      try { detail = (await error.context?.clone?.().json())?.error || detail; } catch (_) { /* Keep SDK message. */ }
      throw new Error(detail);
    }
    if (data?.error) throw new Error(String(data.error));
    return data;
  }

  function demoBars(seed, frame) {
    const step = frame === "D" ? 86400 : frame === "M240" ? 14400 : frame === "M1" ? 60 : 3600;
    const length = frame === "M1" ? 780 : 180;
    const base = Math.floor(Date.now() / 1000 / step) * step - length * step;
    let last = seed;
    return Array.from({ length }, (_, index) => {
      const move = Math.sin(index / 7) * .00045 + Math.cos(index / 15) * .00025 + (index > length - 100 ? .00025 : .00003);
      const open = last, close = open * (1 + move);
      last = close;
      return { time: new Date((base + index * step) * 1000).toISOString(), open, high: Math.max(open, close) * 1.003, low: Math.min(open, close) * .997, close, volume: 800000 + (index * 71431) % 1100000 };
    });
  }

  function demoChain(symbol, side, expiry) {
    const prices = { SKHY: 161.98, CRWV: 81.77, NVDA: 174.42, AMD: 224.15, MU: 138.72, TSLA: 268.05 };
    const price = prices[symbol] || 161.98;
    const chosenExpiry = expiry || "2026-10-16";
    const center = Math.round(price / 5) * 5;
    const contracts = Array.from({ length: 15 }, (_, index) => {
      const strike = center + (index - 7) * 5;
      const distance = Math.abs(strike - price);
      const intrinsic = side === "call" ? Math.max(price - strike, 0) : Math.max(strike - price, 0);
      const mid = intrinsic + .3 + 5.5 * Math.exp(-distance / 22);
      const oi = Math.round((1800 + ((index * 4871 + (side === "put" ? 377 : 0)) % 8500)) * (index % 4 === 0 ? 1.5 : 1));
      return { symbol: `${symbol}${chosenExpiry.replaceAll("-", "").slice(2)}${side === "call" ? "C" : "P"}${String(Math.round(strike * 1000)).padStart(8, "0")}`, expiry: chosenExpiry, option_type: side, strike, multiplier: 100, bid: +(mid - .10).toFixed(2), ask: +(mid + .10).toFixed(2), mid, delta: +(side === "call" ? Math.min(.95, Math.max(.05, .53 - (strike - price) * .015)) : Math.max(-.95, Math.min(-.05, -.45 - (strike - price) * .015))).toFixed(3), theta: -.12, implied_volatility: .43 + index * .006, volume: 35 + (index * 171) % 850, open_interest: oi, quote_time: new Date().toISOString() };
    });
    return { source: "demo", symbol, option_type: side, expiry: chosenExpiry, expiries: [{ value: "2026-10-16", dte: 23 }, { value: "2026-11-20", dte: 58 }], underlying: { price, change_percent: symbol === "CRWV" ? 1.05 : 1.34, market_time: new Date().toISOString() }, contracts, fetched_at: new Date().toISOString() };
  }

  async function getOptionChain(symbol, side, expiry) { return demo ? demoChain(symbol, side, expiry) : edge("option_chain", { symbol, option_type: side, expiry: expiry || null }); }
  async function getChart(instrumentId, frame, symbol) {
    if (demo) {
      const price = demoChain(symbol, "call").underlying.price;
      const bars = demoBars(price, frame);
      const scale = price / bars.at(-1).close;
      return { bars: bars.map((bar) => ({ ...bar, open: bar.open * scale, high: bar.high * scale, low: bar.low * scale, close: bar.close * scale })), fetched_at: new Date().toISOString(), cached: false };
    }
    if (!instrumentId) return null;
    const cached = await edge("chart", { instrument_id: instrumentId, timespan: frame });
    const latestClosedHour = frame === "M60" ? closedBars(cached?.bars, 60).at(-1) : null;
    const hourNeedsRefresh = frame === "M60" && marketOpenNow() && (!latestClosedHour || Date.now() - (latestClosedHour.time + 3600) * 1000 > 65 * 60_000);
    if (!cached?.stale && !hourNeedsRefresh) return cached;
    try { return await edge("chart", { instrument_id: instrumentId, timespan: frame, refresh: true }); }
    catch (error) { return { ...cached, stale: true, refresh_error: error.message }; }
  }

  async function loadWatchlist() {
    state.lastWatchlistReadAt = Date.now();
    if (demo) {
      state.watchlist = ["SKHY", "CRWV", "NVDA", "AMD", "MU", "TSLA"].map((symbol) => ({ symbol, name: "ข้อมูลตัวอย่าง", id: symbol }));
      state.pulse = state.watchlist.map((item) => ({ symbol: item.symbol, price: demoChain(item.symbol, "call").underlying.price }));
      renderWatchlist();
      return;
    }
    const [{ data: watchlist, error: watchError }, { data: pulse, error: pulseError }] = await Promise.all([
      state.db.from("watchlist_items").select("instrument_id,created_at").order("created_at"),
      state.db.from("market_pulse_latest").select("symbol,price,market_time,fetched_at,is_watchlist").eq("is_watchlist", true)
    ]);
    if (watchError) throw new Error(`Watchlist: ${watchError.message}`);
    if (pulseError) throw new Error(`Market Pulse: ${pulseError.message}`);
    state.pulse = pulse || [];
    const ids = [...new Set((watchlist || []).map((item) => item.instrument_id).filter(Boolean))];
    if (!ids.length) { state.watchlist = []; renderWatchlist(); return; }
    const { data: instruments, error: instrumentError } = await state.db.from("instruments").select("id,symbol,display_name,asset_type").in("id", ids);
    if (instrumentError) throw new Error(`Instruments: ${instrumentError.message}`);
    const byId = new Map((instruments || []).map((row) => [row.id, row]));
    state.watchlist = ids.map((id) => byId.get(id)).filter((row) => row && ["stock", "etf"].includes(row.asset_type)).map((row) => ({ id: row.id, symbol: String(row.symbol).toUpperCase(), name: row.display_name || row.symbol }));
    renderWatchlist();
  }

  async function resolveInstrument(symbol) {
    const known = state.watchlist.find((item) => item.symbol === symbol);
    if (known) return known.id;
    if (demo) return symbol;
    const { data, error } = await state.db.from("instruments").select("id,symbol,asset_type").eq("symbol", symbol).in("asset_type", ["stock", "etf"]).limit(1);
    if (error) return null;
    return data?.[0]?.id || null;
  }

  async function loadSymbol(symbol, { expiry = "", refresh = false, options = true, chartFrames = null, background = false } = {}) {
    const normalized = String(symbol || "").trim().toUpperCase();
    if (!/^[A-Z][A-Z0-9.-]{0,9}$/.test(normalized)) { setStatus("กรอก ticker หุ้นสหรัฐให้ถูกต้อง", true); return; }
    if (state.busy && background) return;
    const requestId = ++state.requestId;
    const symbolChanged = normalized !== state.symbol;
    const frames = symbolChanged ? ["M1", "M60"] : Array.isArray(chartFrames) ? chartFrames : refresh ? ["M1", "M60"] : [];
    state.symbol = normalized;
    state.busy = true;
    state.lastError = "";
    if (symbolChanged) { state.call = null; state.put = null; state.expiry = ""; state.contractSymbol = ""; state.charts = {}; state.levelSide = "auto"; }
    if (!background) setStatus("กำลังอ่านราคา กราฟ และ option chain…");
    renderAll();
    try {
      const instrumentId = symbolChanged || !state.instrumentId ? await resolveInstrument(normalized) : state.instrumentId;
      const startedAt = Date.now();
      if (options) state.lastOptionAttemptAt = startedAt;
      frames.forEach((frame) => { state.lastChartAttemptAt[frame] = startedAt; });
      const results = await Promise.allSettled([
        ...(options ? [getOptionChain(normalized, "call", expiry), getOptionChain(normalized, "put", expiry)] : []),
        ...frames.map((frame) => getChart(instrumentId, frame, normalized))
      ]);
      if (requestId !== state.requestId) return;
      const callResult = options ? results[0] : null;
      const putResult = options ? results[1] : null;
      const chartResults = results.slice(options ? 2 : 0);
      state.instrumentId = instrumentId;
      if (options) {
        if (callResult.status === "fulfilled") state.call = callResult.value;
        if (putResult.status === "fulfilled") state.put = putResult.value;
        state.expiry = state.call?.expiry || state.put?.expiry || expiry;
      }
      frames.forEach((frame, index) => { if (chartResults[index]?.status === "fulfilled") state.charts[frame] = chartResults[index].value; });
      const errors = results.filter((result) => result.status === "rejected").map((result) => result.reason?.message || "แหล่งข้อมูลไม่พร้อม");
      for (const result of chartResults) if (result.status === "fulfilled" && result.value?.refresh_error) errors.push(`กราฟ: ${result.value.refresh_error}`);
      if (!instrumentId && frames.length && !demo) errors.push("กราฟใช้ได้เฉพาะหุ้นที่อยู่ในรายการ instruments ของ PCC");
      if (errors.some((message) => /429|rate.?limit|too many requests/i.test(message))) state.quotaPauseUntil = Date.now() + 10 * 60_000;
      setStatus(errors.length ? `ข้อมูลบางส่วนยังไม่พร้อม: ${[...new Set(errors)].join(" · ")}` : "", errors.length > 0);
    } catch (error) {
      if (requestId !== state.requestId) return;
      if (/429|rate.?limit|too many requests/i.test(error.message)) state.quotaPauseUntil = Date.now() + 10 * 60_000;
      setStatus(error.message || "อ่านข้อมูลไม่สำเร็จ", true);
    } finally {
      if (requestId === state.requestId) { state.busy = false; renderAll(); }
    }
  }

  async function showDesk(user) {
    state.user = user;
    $("#auth-shell").hidden = true;
    $("#app-shell").hidden = false;
    $("#account-name").textContent = demo ? "ตัวอย่างในเครื่อง" : user?.email || "PCC member";
    try {
      await loadWatchlist();
      await loadSymbol(state.watchlist[0]?.symbol || "NVDA");
    } catch (error) {
      setStatus(error.message || "โหลดรายการหุ้นไม่สำเร็จ", true);
      renderAll();
    }
  }

  function showLogin() {
    state.requestId++;
    state.user = null;
    clearChart();
    $("#app-shell").hidden = true;
    $("#auth-shell").hidden = false;
  }

  async function init() {
    if (!priceLevels?.calculate || !priceLevels?.describe) {
      $("#auth-shell").hidden = false;
      $("#auth-message").textContent = "โหลดสูตรคำนวณระดับราคาไม่สำเร็จ กรุณารีเฟรชหน้า";
      return;
    }
    if (demo) { await showDesk({ email: "preview@local" }); return; }
    if (!config?.supabaseUrl || !config?.supabasePublishableKey || !window.supabase?.createClient) {
      $("#auth-shell").hidden = false;
      $("#auth-message").textContent = "โหลดการเชื่อมต่อ PCC ไม่สำเร็จ กรุณารีเฟรชหน้า";
      return;
    }
    state.db = window.supabase.createClient(config.supabaseUrl, config.supabasePublishableKey, { auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true } });
    const { data: { session } } = await state.db.auth.getSession();
    if (session?.user) await showDesk(session.user); else showLogin();
    state.db.auth.onAuthStateChange((event, session) => { if (event === "SIGNED_OUT" && !session) showLogin(); });
  }

  $("#login-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const button = form.querySelector("button");
    button.disabled = true;
    $("#auth-message").textContent = "กำลังเข้าสู่ระบบ…";
    try {
      const emailField = form.elements.namedItem("email");
      const passwordField = form.elements.namedItem("password");
      const { data, error } = await state.db.auth.signInWithPassword({ email: emailField.value.trim(), password: passwordField.value });
      if (error) throw error;
      passwordField.value = "";
      await showDesk(data.user);
    } catch (error) {
      $("#auth-message").textContent = error.message || "เข้าสู่ระบบไม่สำเร็จ";
    } finally { button.disabled = false; }
  });
  $("#sign-out").addEventListener("click", async () => { if (!demo) await state.db.auth.signOut(); else location.href = location.pathname; });
  $("#watch-search").addEventListener("input", (event) => { state.search = event.target.value.trim().toUpperCase(); renderWatchlist(); });
  $("#watch-list").addEventListener("click", (event) => { const button = event.target.closest("[data-symbol]"); if (button) loadSymbol(button.dataset.symbol); });
  $("#symbol-form").addEventListener("submit", (event) => { event.preventDefault(); loadSymbol($("#symbol-input").value); });
  $("#refresh-button").addEventListener("click", () => {
    if (Date.now() - state.lastManualAt < 30_000) { setStatus("เพิ่งรีเฟรชไป · รออย่างน้อย 30 วินาทีเพื่อถนอมโควต้า"); return; }
    state.lastManualAt = Date.now();
    loadSymbol(state.symbol, { expiry: state.expiry, refresh: true });
  });
  $("#chart-frames").addEventListener("click", (event) => {
    const button = event.target.closest("[data-frame]");
    if (!button) return;
    state.chartFrame = button.dataset.frame;
    renderChart();
    const sourceFrame = ["M5", "M15"].includes(state.chartFrame) ? "M1" : state.chartFrame;
    if (!state.charts[sourceFrame] && !state.busy) void loadSymbol(state.symbol, { options: false, chartFrames: [sourceFrame] });
  });
  $("#level-side").addEventListener("click", (event) => {
    const button = event.target.closest("[data-level-side]");
    if (!button) return;
    state.levelSide = button.dataset.levelSide;
    renderLevels();
    renderChart();
  });
  $("#expiry-select").addEventListener("change", (event) => loadSymbol(state.symbol, { expiry: event.target.value }));
  $("#option-side").addEventListener("click", (event) => { const button = event.target.closest("[data-side]"); if (button) { state.side = button.dataset.side; state.contractSymbol = ""; renderContract(); } });
  $("#contract-list").addEventListener("click", (event) => { const button = event.target.closest("[data-contract]"); if (button) { state.contractSymbol = button.dataset.contract; renderContract(); } });
  $("#oi-rows").addEventListener("click", (event) => {
    const button = event.target.closest("[data-pick-strike]");
    if (!button) return;
    state.side = button.dataset.pickSide;
    const selected = contracts(state.side).find((item) => Number(item.strike) === Number(button.dataset.pickStrike));
    state.contractSymbol = selected?.symbol || "";
    renderContract();
    if (matchMedia("(max-width: 760px)").matches) $(".contract-panel").scrollIntoView({ behavior: "smooth" });
  });

  async function maybeAutoRefresh() {
    renderDataStatus();
    const previousPlanDirection = state.planDirection;
    renderSignals();
    renderLevels();
    if (previousPlanDirection !== state.planDirection) renderChart();
    if (demo || !state.user || !state.symbol || state.busy || document.hidden || !marketOpenNow()) return;
    if (Date.now() - state.lastInteractionAt > IDLE_PAUSE_MS || Date.now() < state.quotaPauseUntil) return;
    if (Date.now() - state.lastWatchlistReadAt >= 15 * 60_000) {
      try { await loadWatchlist(); } catch (error) { setStatus(`Watchlist: ${error.message}`, true); }
    }
    const now = Date.now();
    const needOptions = now - state.lastOptionAttemptAt >= OPTION_POLL_MS;
    const frames = [];
    if (now - (state.lastChartAttemptAt.M1 || 0) >= MINUTE_POLL_MS) frames.push("M1");
    if (now - (state.lastChartAttemptAt.M60 || 0) >= HOUR_POLL_MS) frames.push("M60");
    if (needOptions || frames.length) await loadSymbol(state.symbol, { expiry: state.expiry, options: needOptions, chartFrames: frames, background: true });
  }

  document.addEventListener("pointerdown", () => { state.lastInteractionAt = Date.now(); }, { passive: true });
  document.addEventListener("keydown", () => { state.lastInteractionAt = Date.now(); });
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) { state.lastInteractionAt = Date.now(); void maybeAutoRefresh(); }
    else renderDataStatus();
  });
  window.setInterval(() => { void maybeAutoRefresh(); }, 30_000);

  init();
})();
