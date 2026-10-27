(() => {
  "use strict";

  const config = window.__OPTION_DESK_CONFIG__;
  const priceLevels = window.OptionDeskLevels;
  const tradePlan = window.OptionDeskTradePlan;
  const chartTime = window.OptionDeskChartTime;
  const focusList = window.OptionDeskFocus;
  const sessionVwap = window.OptionDeskSessionVwap;
  const apiError = window.OptionDeskApiError;
  const signalPolicy = window.OptionDeskSignalPolicy;
  const demoJournal = window.OptionDeskDemoJournal;
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
    db: null, user: null, focusSymbols: [], focusAssetTypes: {}, focusSignals: {}, alerts: [], focusInstrumentIds: {},
    focusScanAt: 0, focusScanCursor: 0, focusScanBusy: false, symbol: "", instrumentId: null,
    call: null, put: null, expiry: "", side: "call", contractSymbol: "", charts: {}, chartFrame: "M1",
    chart: null, resizeObserver: null, busy: false, requestId: 0, lastError: "",
    lastOptionAttemptAt: 0, lastChartAttemptAt: {},
    lastInteractionAt: Date.now(), lastManualAt: 0, quotaPauseUntil: 0, planDirection: "wait", levelSide: "auto",
    tradePlan: null, optionGate: null, vwapGate: null, planBlock: "", signalAssessment: null,
    swRegistration: null, deviceSubscribed: false, serverMonitorEnabled: false, serverPauseUntil: 0, monitorError: "", lastMonitorReadAt: 0
  };

  const OPTION_POLL_MS = 3 * 60_000;
  const MINUTE_POLL_MS = 2 * 60_000;
  const HOUR_POLL_MS = 45 * 60_000;
  const FOCUS_SCAN_SPACING_MS = 45_000;
  let alertToastTimer = null;

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

  function closedBars(input, frame, source) {
    return chartTime.completedBars(normalizeBars(input), frame, source?.fetched_at);
  }

  function aggregateBars(input, minutes, source = state.charts.M1) {
    const groups = new Map();
    for (const bar of closedBars(input, "M1", source)) {
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

  function barsFor(frame, charts = state.charts) {
    if (frame === "M5") return aggregateBars(charts.M1?.bars, 5, charts.M1);
    if (frame === "M15") return aggregateBars(charts.M1?.bars, 15, charts.M1);
    return closedBars(charts[frame]?.bars, frame, charts[frame]);
  }

  function sourceFor(frame, charts = state.charts) { return charts[["M5", "M15"].includes(frame) ? "M1" : frame]; }

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

  function trendFor(frame, charts = state.charts) {
    const bars = barsFor(frame, charts);
    const lastBar = bars.at(-1), closeTime = chartTime.barEndMs(lastBar, frame);
    const reference = { lastBar, closeTime };
    if (bars.length < 25) return { ...reference, direction: "wait", label: "รอข้อมูล", detail: "แท่งราคาไม่พอ" };
    if (!marketOpenNow()) return { ...reference, direction: "wait", label: "ตลาดปิด", detail: "ไม่คอนเฟิร์มนอกเวลาตลาด", closed: true };
    // A completed higher-timeframe candle stays valid until its successor closes.
    // Give each frame one full candle plus a small provider/cache arrival margin.
    const maxLag = { M1: 4, M5: 8, M15: 18, M60: 65 }[frame] || 65;
    if (sourceFor(frame, charts)?.stale || Date.now() - closeTime > maxLag * 60_000) {
      return { ...reference, direction: "wait", label: "ข้อมูลเก่า", detail: "รอแท่งราคาใหม่", stale: true };
    }
    return { ...reference, ...technicalTrend(bars) };
  }

  function hourContext(charts = state.charts) {
    const bars = barsFor("M60", charts);
    const lastBar = bars.at(-1), closeTime = chartTime.barEndMs(lastBar, "M60");
    if (!lastBar || !closeTime || Date.now() - closeTime > 7 * 24 * 60 * 60_000) {
      return { lastBar, closeTime, direction: "wait", label: "ไม่มีบริบท", detail: "แท่ง 1h เก่ามากหรือไม่มีข้อมูล" };
    }
    const raw = bars.length >= 25 ? technicalTrend(bars) : signalPolicy.priceActionContext(bars);
    return {
      lastBar, closeTime, direction: raw.direction,
      label: raw.direction === "up" ? "ขึ้นเดิม" : raw.direction === "down" ? "ลงเดิม" : "แกว่ง",
      detail: `${raw.detail} · บริบทเท่านั้น ไม่ใช้ยืนยันจุดเข้า`
    };
  }

  function focusStorageKey(kind) { return `option-desk:${kind}:v1:${state.user?.id || "demo"}`; }

  function loadFocusPreferences() {
    try {
      const saved = localStorage.getItem(focusStorageKey("focus"));
      state.focusSymbols = saved === null ? [...focusList.DEFAULT_SYMBOLS] : focusList.cleanSymbols(JSON.parse(saved));
      const types = JSON.parse(localStorage.getItem(focusStorageKey("focus-types")) || "{}");
      state.focusAssetTypes = types && typeof types === "object" && !Array.isArray(types) ? types : {};
      state.focusAssetTypes.QQQ = "etf";
      const alerts = JSON.parse(localStorage.getItem(focusStorageKey("alerts")) || "[]");
      state.alerts = Array.isArray(alerts) ? alerts.filter((item) => item && typeof item.id === "string" && typeof item.symbol === "string" && typeof item.title === "string" && typeof item.body === "string" && Number.isFinite(item.at) && Number.isFinite(new Date(item.at).getTime())).slice(0, 20) : [];
    } catch (_) {
      state.focusSymbols = [...focusList.DEFAULT_SYMBOLS];
      state.focusAssetTypes = { QQQ: "etf" };
      state.alerts = [];
    }
  }

  function saveFocusPreferences() {
    try {
      localStorage.setItem(focusStorageKey("focus"), JSON.stringify(state.focusSymbols));
      localStorage.setItem(focusStorageKey("focus-types"), JSON.stringify(state.focusAssetTypes));
    }
    catch (_) { $("#focus-feedback").textContent = "บันทึกรายการในเบราว์เซอร์ไม่ได้ · รายการอาจหายเมื่อปิดหน้า"; }
    if (!demo && state.db && state.user) void persistMonitorSettings();
  }

  async function persistMonitorSettings() {
    const { error } = await state.db.from("option_desk_monitor_settings").update({
      symbols: state.focusSymbols, asset_types: state.focusAssetTypes, updated_at: new Date().toISOString()
    }).eq("user_id", state.user.id);
    if (error) { state.monitorError = "ซิงก์หุ้นเฝ้าไปเซิร์ฟเวอร์ไม่สำเร็จ"; renderAlerts(); }
  }

  async function initMonitor() {
    if (demo) return;
    try {
      const { data, error } = await state.db.from("option_desk_monitor_settings")
        .select("symbols,asset_types,enabled").eq("user_id", state.user.id).maybeSingle();
      if (error) throw error;
      if (data) {
        state.focusSymbols = focusList.cleanSymbols(data.symbols);
        state.focusAssetTypes = data.asset_types && typeof data.asset_types === "object" ? data.asset_types : {};
        state.serverMonitorEnabled = Boolean(data.enabled);
        localStorage.setItem(focusStorageKey("focus"), JSON.stringify(state.focusSymbols));
        localStorage.setItem(focusStorageKey("focus-types"), JSON.stringify(state.focusAssetTypes));
      } else {
        const { error: insertError } = await state.db.from("option_desk_monitor_settings")
          .insert({ user_id: state.user.id, symbols: state.focusSymbols, asset_types: state.focusAssetTypes });
        if (insertError) throw insertError;
      }
      await Promise.allSettled(state.focusSymbols.map((symbol) => resolveInstrument(symbol)));
      await readMonitorState();
      if ("serviceWorker" in navigator) {
        state.swRegistration = await navigator.serviceWorker.register("./sw.js", { scope: "./" });
        const existing = await state.swRegistration.pushManager?.getSubscription();
        if (existing && Notification.permission === "granted") {
          await saveSubscription(existing);
          state.deviceSubscribed = true;
        }
      }
      state.monitorError = "";
    } catch (error) {
      state.monitorError = `เซิร์ฟเวอร์แจ้งเตือนยังไม่พร้อม: ${error.message || "เชื่อมต่อไม่สำเร็จ"}`;
    }
    renderWatchlist(); renderAlerts(); renderDataStatus();
  }

  async function readMonitorState() {
    if (!state.db || !state.user || document.hidden) return;
    state.lastMonitorReadAt = Date.now();
    const { data: settings, error: settingsError } = await state.db.from("option_desk_monitor_settings")
      .select("enabled,pause_until").eq("user_id", state.user.id).maybeSingle();
    if (settingsError) { state.monitorError = "อ่านสถานะเซิร์ฟเวอร์ไม่สำเร็จ"; renderAlerts(); return; }
    state.serverMonitorEnabled = Boolean(settings?.enabled);
    state.serverPauseUntil = Date.parse(settings?.pause_until || "") || 0;
    if (!state.serverMonitorEnabled) { renderAlerts(); renderDataStatus(); return; }
    const [{ data: rows, error }, { data: events, error: eventError }] = await Promise.all([
      state.db.from("option_desk_monitor_state").select("symbol,direction,tier,fresh,price,as_of,checked_at,last_error")
        .eq("user_id", state.user.id),
      state.db.from("option_desk_monitor_events").select("id,symbol,direction,tier,as_of,created_at")
        .eq("user_id", state.user.id).order("created_at", { ascending: false }).limit(20)
    ]);
    if (error || eventError) { state.monitorError = "อ่านสถานะสแกนจากเซิร์ฟเวอร์ไม่สำเร็จ"; renderAlerts(); return; }
    for (const row of rows || []) if (state.focusSymbols.includes(row.symbol) && row.symbol !== state.symbol) {
      state.focusSignals[row.symbol] = {
        direction: row.direction, tier: row.tier, fresh: row.fresh,
        price: numeric(row.price), asOf: Number(row.as_of), checkedAt: Date.parse(row.checked_at || "") || 0,
        error: row.last_error || undefined
      };
    }
    for (const event of [...(events || [])].reverse()) {
      const id = `server:${event.id}`;
      if (state.alerts.some((item) => item.id === id)) continue;
      const side = event.direction === "up" ? "CALL" : "PUT";
      state.alerts.unshift({ id, symbol: event.symbol, title: `${event.symbol} · เริ่มเฝ้า ${side}`,
        body: `${event.tier === "aligned" ? "แท่งปิด 1m/5m/15m ตรงกัน" : "แท่งปิด 1m+5m ตรงกัน"} · ตรวจสัญญาก่อน`, at: Date.parse(event.created_at) });
    }
    state.alerts = state.alerts.slice(0, 20);
    try { localStorage.setItem(focusStorageKey("alerts"), JSON.stringify(state.alerts)); } catch (_) { /* Keep in memory. */ }
    renderWatchlist(); renderAlerts();
  }

  function pushSupported() {
    const iphone = /iPhone|iPad|iPod/.test(navigator.userAgent);
    const standalone = window.navigator.standalone || matchMedia("(display-mode: standalone)").matches;
    return window.isSecureContext && "Notification" in window && "serviceWorker" in navigator && "PushManager" in window
      && Boolean(config?.vapidPublicKey) && (!iphone || standalone);
  }

  function vapidBytes(key) {
    const binary = atob(key.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - key.length % 4) % 4));
    return Uint8Array.from(binary, (character) => character.charCodeAt(0));
  }

  function encodedKey(buffer) {
    return btoa(String.fromCharCode(...new Uint8Array(buffer))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }

  async function saveSubscription(subscription) {
    const keys = { p256dh: encodedKey(subscription.getKey("p256dh")), auth: encodedKey(subscription.getKey("auth")) };
    const { error } = await state.db.from("option_desk_push_subscriptions").upsert({
      user_id: state.user.id, endpoint: subscription.endpoint, ...keys, updated_at: new Date().toISOString()
    }, { onConflict: "endpoint" });
    if (error) throw error;
  }

  async function enablePush() {
    if (!pushSupported()) return;
    const permission = Notification.permission === "default" ? await Notification.requestPermission() : Notification.permission;
    if (permission !== "granted") { renderAlerts(); return; }
    try {
      state.swRegistration ||= await navigator.serviceWorker.register("./sw.js", { scope: "./" });
      const registration = await navigator.serviceWorker.ready;
      const subscription = await registration.pushManager.getSubscription()
        || await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: vapidBytes(config.vapidPublicKey) });
      await saveSubscription(subscription);
      const { error } = await state.db.from("option_desk_monitor_settings").update({ enabled: true })
        .eq("user_id", state.user.id);
      if (error) throw error;
      state.deviceSubscribed = true;
      state.serverMonitorEnabled = true;
      state.monitorError = "";
      void readMonitorState();
    } catch (error) { state.monitorError = `เปิดแจ้งเตือนไม่สำเร็จ: ${error.message || "ไม่ทราบสาเหตุ"}`; }
    renderAlerts(); renderDataStatus();
  }

  async function disablePush() {
    try {
      const registration = state.swRegistration || await navigator.serviceWorker.ready;
      const subscription = await registration.pushManager.getSubscription();
      if (subscription) {
        const { error } = await state.db.from("option_desk_push_subscriptions").delete()
          .eq("user_id", state.user.id).eq("endpoint", subscription.endpoint);
        if (error) throw error;
        await subscription.unsubscribe();
      }
      state.deviceSubscribed = false;
      const { count } = await state.db.from("option_desk_push_subscriptions")
        .select("id", { head: true, count: "exact" }).eq("user_id", state.user.id);
      if (!count) {
        await state.db.from("option_desk_monitor_settings").update({ enabled: false }).eq("user_id", state.user.id);
        state.serverMonitorEnabled = false;
      }
      state.monitorError = "";
    } catch (error) { state.monitorError = `ปิดแจ้งเตือนไม่สำเร็จ: ${error.message || "ไม่ทราบสาเหตุ"}`; }
    renderAlerts(); renderDataStatus();
  }

  function focusSummary(charts) {
    const trends = Object.fromEntries(["M1", "M5", "M15"].map((frame) => [frame, trendFor(frame, charts)]));
    const assessment = signalPolicy.assess(trends, marketOpenNow());
    return {
      ...assessment, price: trends.M1.lastBar?.close ?? null,
      asOf: trends.M1.closeTime || 0, checkedAt: Date.now()
    };
  }

  function renderWatchlist() {
    const marketOpen = marketOpenNow();
    const now = Date.now();
    $("#watch-list").innerHTML = state.focusSymbols.length ? state.focusSymbols.map((symbol) => {
      const signal = state.focusSignals[symbol];
      const display = focusList.presentation(signal, { marketOpen, now });
      return `<div class="focus-row ${display.tone} ${display.level} ${symbol === state.symbol ? "active" : ""}"><button class="focus-open" type="button" data-symbol="${esc(symbol)}" aria-pressed="${symbol === state.symbol}"><strong class="focus-ticker">${esc(symbol)}</strong><span class="focus-price">${display.current ? money(signal?.price) : "—"}</span><span class="focus-signal"><b class="focus-label">${esc(display.label)}</b><i class="focus-led" aria-hidden="true"></i></span><small class="focus-detail">${esc(display.detail)}</small></button><button class="focus-remove" type="button" data-remove-symbol="${esc(symbol)}" aria-label="ลบ ${esc(symbol)} จากหุ้นเฝ้าเทรด" title="ลบจากหุ้นเฝ้าเทรด">×</button></div>`;
    }).join("") : `<p class="empty-list">ยังไม่มีหุ้นเฝ้าเทรด · เพิ่ม ticker ด้านบน</p>`;
    $("#focus-scan-note").textContent = `${state.focusSymbols.length}/${focusList.MAX_SYMBOLS} ตัว · 1m+5m เริ่มเฝ้า · 15m ช่วยยืนยัน · 1h เป็นบริบท ไม่ใช่จุดซื้อ`;
  }

  function renderAlerts() {
    $("#alert-list").innerHTML = state.alerts.length ? state.alerts.slice(0, 5).map((item) => `<li><button type="button" data-alert-symbol="${esc(item.symbol)}"><strong>${esc(item.title)}</strong><span>${esc(item.body)}</span><time datetime="${new Date(item.at).toISOString()}">${bkkTime(item.at)}</time></button></li>`).join("") : `<li class="alert-empty">ยังไม่มีแจ้งเตือนใหม่</li>`;
    const supported = pushSupported();
    const permission = "Notification" in window ? Notification.permission : "unsupported";
    const button = $("#notify-button");
    button.disabled = !supported || permission === "denied" || state.deviceSubscribed;
    button.textContent = state.deviceSubscribed ? "แจ้งเตือนเครื่องนี้: เปิดแล้ว" : permission === "denied" ? "แจ้งเตือนถูกบล็อก" : supported ? "เปิดแจ้งเตือนเครื่องนี้" : "เปิดจากแอปบนหน้าจอหลัก";
    $("#notify-test").hidden = !state.deviceSubscribed;
    $("#notify-disable").hidden = !state.deviceSubscribed;
    const iphone = /iPhone|iPad|iPod/.test(navigator.userAgent);
    $("#notify-state").textContent = state.monitorError || (state.deviceSubscribed && state.serverMonitorEnabled
      ? Date.now() < state.serverPauseUntil ? "เซิร์ฟเวอร์พักหลังเจอโควต้าข้อมูล · จะลองใหม่อัตโนมัติ" : "เซิร์ฟเวอร์สแกนหุ้นเฝ้าแม้ปิดหน้า · สูงสุด 2 ตัว/นาที · แจ้งเมื่อทิศทางใหม่เปลี่ยน"
      : iphone && !supported ? "บน iPhone ต้องเพิ่มเว็บไปหน้าจอหลักก่อน แล้วเปิดแอปจากไอคอนเพื่อรับ Push"
      : permission === "denied" ? "อนุญาตแจ้งเตือนใหม่ในตั้งค่าเว็บไซต์ของเบราว์เซอร์"
      : "สิทธิ์แจ้งเตือนอย่างเดียวไม่พอ ต้องกดเปิด Push เครื่องนี้ก่อน");
  }

  function emitAlert(id, symbol, title, body, at = Date.now()) {
    if (state.alerts.some((item) => item.id === id)) return;
    const item = { id, symbol, title, body, at };
    state.alerts.unshift(item);
    state.alerts = state.alerts.slice(0, 20);
    try { localStorage.setItem(focusStorageKey("alerts"), JSON.stringify(state.alerts)); } catch (_) { /* Keep alerts in this tab. */ }
    renderAlerts();
    const toast = $("#alert-toast");
    toast.innerHTML = `<strong>${esc(title)}</strong><span>${esc(body)}</span>`;
    toast.hidden = false;
    clearTimeout(alertToastTimer);
    alertToastTimer = setTimeout(() => { toast.hidden = true; }, 9_000);
    if (!demo && state.swRegistration && "Notification" in window && Notification.permission === "granted") {
      void state.swRegistration.showNotification(title, { body, tag: id, icon: "app-icon-luxury.png" }).catch(() => {});
    }
  }

  function updateFocusSignal(symbol, summary) {
    if (!state.focusSymbols.includes(symbol)) return;
    const previous = state.focusSignals[symbol];
    state.focusSignals[symbol] = summary;
    const direction = focusList.transition(previous, summary);
    if (direction && marketOpenNow() && !demo && !state.serverMonitorEnabled) {
      const side = direction === "up" ? "CALL" : "PUT";
      emitAlert(`watch:${symbol}:${side}:${summary.asOf}`, symbol, `${symbol} · เริ่มเฝ้า ${side}`, `${summary.tier === "aligned" ? "แท่งปิด 1m/5m/15m ตรงกัน" : "สัญญาณเร็วจากแท่งปิด 1m+5m"} · 1h เป็นบริบท · ยังไม่ใช่จุดเข้า ตรวจ Option และแผนก่อน`);
    }
    renderWatchlist();
  }

  function updateFocusFromSelected() {
    if (state.focusSymbols.includes(state.symbol) && state.charts.M1) updateFocusSignal(state.symbol, focusSummary(state.charts));
  }

  function renderHeader() {
    const underlying = state.call?.underlying || state.put?.underlying || null;
    const price = underlying?.price;
    const change = underlying?.change_percent;
    $("#symbol-title").textContent = state.symbol || "—";
    $("#spot-price").textContent = money(price);
    $("#spot-change").textContent = signedPercent(change);
    $("#spot-change").className = `ticker-change ${numeric(change) === null ? "" : Number(change) >= 0 ? "positive" : "negative"}`;
    $("#spot-time").textContent = underlying ? `ราคา quote หุ้น ณ ${bkkTime(underlying.market_time)} · ข้อมูล Option ณ ${bkkTime(state.call?.fetched_at || state.put?.fetched_at)} · เวลาไทย` : state.busy ? "กำลังโหลดข้อมูล" : "เลือกหุ้นเพื่อดูข้อมูล";
    $("#symbol-input").value = state.symbol;
    $("#refresh-button").disabled = state.busy || !state.symbol;
    const badge = $("#source-pill");
    badge.textContent = demo ? "DEMO / ข้อมูลตัวอย่าง" : state.call || state.put ? "WEBULL OPRA" : "รอข้อมูล";
    badge.className = `source-pill ${demo ? "demo" : state.call || state.put ? "live" : ""}`;
    $("#market-status").textContent = demo ? "โหมดตัวอย่าง" : state.busy ? "กำลังอ่านข้อมูล" : state.call || state.put ? "เชื่อม PCC แล้ว" : "รอข้อมูล";
    $("#market-status").classList.toggle("is-demo", demo);
  }

  function renderSignals() {
    const short = Object.fromEntries(["M1", "M5", "M15"].map((frame) => [frame, trendFor(frame)]));
    const assessment = signalPolicy.assess(short, marketOpenNow());
    state.signalAssessment = assessment;
    const trends = [["M1", "1m", short.M1], ["M5", "5m", short.M5], ["M15", "15m", short.M15], ["M60", "1h", hourContext()]];
    $("#signal-grid").innerHTML = trends.map(([frame, label, trend]) => `<div class="signal-card ${frame === "M60" ? "context" : ""}"><small>${label} · ${frame === "M60" ? "บริบทย้อนหลัง" : "แท่งปิด"}</small><div class="signal-primary"><strong class="${trend.direction}">${trend.label}</strong><b>${money(trend.lastBar?.close)}</b></div>${trend.closeTime ? `<time datetime="${new Date(trend.closeTime).toISOString()}">ปิด ${chartTime.formatBangkok(trend.closeTime / 1000)}</time>` : `<span class="signal-time">รอแท่งปิด</span>`}<span>${esc(trend.detail)}</span></div>`).join("");
    const verdict = $("#signal-verdict");
    let message = "รอข้อมูลกราฟ", detail = "ยังประเมินแนวโน้มไม่ได้", tone = "wait";
    if (!marketOpenNow()) { message = "ตลาดสหรัฐฯ ปิด"; detail = "แสดงแท่งย้อนหลังเป็นบริบท · ไม่แจ้งสัญญาณเข้าใหม่"; }
    else if (assessment.direction !== "wait") {
      tone = assessment.direction;
      message = `${assessment.tier === "aligned" ? "ทิศทางตรงกัน 3/3" : "สัญญาณเร็ว 1m+5m"} · เฝ้า ${tone === "up" ? "CALL" : "PUT"}`;
      detail = `${assessment.tier === "aligned" ? "15m ยืนยันแล้ว" : "15m ยังไม่ยืนยัน แต่ไม่สวนทาง"} · 1h เป็นบริบท · ยังไม่ใช่จุดเข้า`;
    } else if (assessment.opposed) { message = "15m สวนทาง"; detail = "1m+5m ตรงกัน แต่ 15m คัดค้าน · รอจังหวะใหม่"; }
    else if (!assessment.fresh) { message = "รอแท่งสั้นใหม่"; detail = "ต้องมี 1m และ 5m ที่ปิดแล้วและข้อมูลสด · ไม่รอ 1h"; }
    else { message = "ทิศทางยังไม่ตรง"; detail = "1m+5m ยังไม่ไปทางเดียวกัน · 1h ใช้ดูบริบทเท่านั้น"; }
    verdict.className = `signal-verdict ${tone}`;
    verdict.innerHTML = `<span>${message}</span><small>${detail}</small>`;
    const quoteFresh = (side) => {
      const quoteTimes = contracts(side).map((item) => new Date(item.quote_time).getTime()).filter(Number.isFinite);
      return quoteTimes.length > 0 && Date.now() - Math.max(...quoteTimes) < 5 * 60_000;
    };
    const callWatch = assessment.direction === "up";
    const putWatch = assessment.direction === "down";
    const callReady = callWatch && quoteFresh("call");
    const putReady = putWatch && quoteFresh("put");
    state.planDirection = callReady ? "up" : putReady ? "down" : "wait";
    const lane = (side, watch, ready) => `<div class="option-lane ${watch ? `${side} ${ready ? "active" : "watch"}` : ""}"><span>${side.toUpperCase()} / ฝั่ง${side === "call" ? "ขึ้น" : "ลง"}</span><strong>${ready ? "ทิศทางผ่าน" : watch ? "เฝ้าดู" : "WAIT"}</strong><small>${ready ? `${assessment.tier === "aligned" ? "3/3" : "เร็ว 2/3"} · Quote สด · ยังไม่ใช่จุดเข้า` : watch ? "ทิศทางหุ้นมีแล้ว · รอ Option quote" : "ยังไม่ครบเงื่อนไข"}</small></div>`;
    $("#option-signal").innerHTML = lane("call", callWatch, callReady) + lane("put", putWatch, putReady);
  }

  function tradingDate(now = Date.now()) {
    const parts = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date(now));
    const value = (type) => parts.find((part) => part.type === type)?.value || "";
    return `${value("year")}-${value("month")}-${value("day")}`;
  }

  function planStorageKey() { return `option-desk:plan:v1:${state.user?.id || "demo"}:${state.symbol}`; }
  function readStoredPlan() {
    try {
      const plan = JSON.parse(localStorage.getItem(planStorageKey()) || "null");
      if (!plan || plan.symbol !== state.symbol || plan.sessionKey !== tradingDate()
        || !["armed", "triggered", "tp1", "tp2", "stopped", "cancelled", "missed", "ambiguous", "data_gap", "session_end"].includes(plan.status)
        || ![plan.entry, plan.stop, plan.tp1, plan.tp2, plan.risk, plan.basedOn, plan.lastSeenBarTime, plan.createdAt].every(Number.isFinite)
        || typeof plan.contractSymbol !== "string") return null;
      return plan;
    } catch (_) { return null; }
  }
  function savePlan() {
    try {
      if (state.tradePlan) localStorage.setItem(planStorageKey(), JSON.stringify(state.tradePlan));
      else localStorage.removeItem(planStorageKey());
    } catch (_) { /* The dashboard still works without browser storage. */ }
  }

  function selectedTradeContract(direction) {
    const side = direction === "up" ? "call" : direction === "down" ? "put" : "";
    return state.side === side ? contracts(side).find((row) => row.symbol === state.contractSymbol) : null;
  }

  function updateTradePlan() {
    if (!tradePlan?.reconcile || !state.symbol || state.busy) return;
    const bars = barsFor("M5"), minuteBars = barsFor("M1"), source = sourceFor("M5");
    const lastFive = bars.at(-1), lastMinute = minuteBars.at(-1);
    const direction = state.planDirection !== "wait" ? state.planDirection : state.tradePlan?.direction || "wait";
    const candidate = direction !== "wait" ? priceLevels.calculate(bars, direction) : null;
    const now = Date.now();
    const sessionKey = tradingDate(now);
    const vwap = sessionVwap.calculate(minuteBars, sessionKey);
    const chartFresh = Boolean(lastFive && lastMinute && !source?.stale
      && now - (lastFive.time + 300) * 1000 <= 8 * 60_000
      && now - (lastMinute.time + 60) * 1000 <= 4 * 60_000);
    const marketOpen = marketOpenNow();
    state.vwapGate = marketOpen && chartFresh
      ? { ...sessionVwap.check(vwap, direction, lastMinute), ready: vwap.ready }
      : { ok: false, ready: false, value: null, reason: marketOpen ? "รอกราฟสด" : "ตลาดปิด" };
    const previousPlan = state.tradePlan;
    const result = tradePlan.reconcile(previousPlan, {
      symbol: state.symbol, sessionKey, candidate,
      confirmed: state.planDirection === direction && direction !== "wait" && !candidate?.wideRisk,
      marketOpen, chartFresh,
      contract: selectedTradeContract(direction), bars: minuteBars, vwap, now
    });
    state.tradePlan = result.plan;
    state.optionGate = result.option;
    state.planBlock = result.block || "";
    savePlan();
    if (state.focusSymbols.includes(state.symbol) && previousPlan && result.plan && previousPlan.status !== result.plan.status) {
      const plan = result.plan;
      const quote = plan.detectedQuote;
      const messages = {
        triggered: [`${state.symbol} · Entry ผ่าน`, `หุ้นปิดผ่าน ${money(plan.entry)} และ VWAP ${money(plan.vwapAtTrigger)} · ${plan.contractSymbol} bid/ask ${money(quote?.bid)} / ${money(quote?.ask)} ณ ${quote?.quoteAt ? bkkTime(quote.quoteAt) : "ไม่ทราบเวลา"} · ตรวจ broker ก่อนตัดสินใจ`],
        tp1: [`${state.symbol} · หุ้นแตะ TP1`, `ราคาหุ้นแตะ ${money(plan.tp1)} · ตรวจสถานะสัญญาจริง`],
        tp2: [`${state.symbol} · หุ้นแตะ TP2`, `ราคาหุ้นแตะ ${money(plan.tp2)} · ตรวจสถานะสัญญาจริง`],
        stopped: [`${state.symbol} · หุ้นแตะ SL`, `ราคาหุ้นแตะ ${money(plan.stop)} · ไม่ใช่คำสั่งขายออปชัน`],
        data_gap: [`${state.symbol} · ข้อมูลขาดช่วง`, `ระบบหยุดติดตามแผน · ตรวจสถานะจริงใน broker`]
      };
      if (messages[plan.status]) emitAlert(`plan:${state.symbol}:${plan.createdAt}:${plan.status}`, state.symbol, ...messages[plan.status], plan.statusAt || now);
    }
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
      : state.planDirection !== "wait" ? state.planDirection
      : ["up", "down"].includes(state.signalAssessment?.direction) ? state.signalAssessment.direction : watchDirection;
    const tracked = state.levelSide === "auto" ? state.tradePlan : null;
    const plan = tracked || (recentHistory && direction !== "wait" ? priceLevels.calculate(bars, direction) : null);
    const livePlan = Boolean(tracked && ["armed", "triggered", "tp1"].includes(tracked.status) && fresh);
    return { indicators, plan, fresh, source, livePlan, recentHistory, tracked };
  }

  function renderPlanWorkflow(tracked) {
    const box = $("#plan-workflow");
    const lastMinute = barsFor("M1").at(-1);
    const labels = { armed: "เฝ้าทะลุ · ยังไม่เข้า", triggered: "ทะลุยืนยัน · ตรวจ Option", tp1: "ราคาหุ้นแตะ TP1", tp2: "ราคาหุ้นแตะ TP2", stopped: "ราคาหุ้นแตะ SL", cancelled: "ยกเลิก setup", missed: "พลาดจุดเข้า · ไม่ไล่ราคา", ambiguous: "ลำดับราคาไม่ชัด", data_gap: "ข้อมูลขาดช่วง · หยุดแผน", session_end: "จบรอบตลาด" };
    const active = tracked && ["armed", "triggered", "tp1"].includes(tracked.status);
    const tone = tracked?.direction === "down" ? "down" : "up";
    const manual = state.levelSide !== "auto";
    const title = manual ? "โหมดจำลอง · ไม่ใช่จุดเข้า" : tracked ? labels[tracked.status] || "รอข้อมูล" : "รอ setup ที่ครบเงื่อนไข";
    let detail = "";
    if (manual) detail = `กำลังดูฝั่ง ${state.levelSide.toUpperCase()} แบบจำลอง · ${state.tradePlan ? "แผนที่ล็อกจริงยังอยู่ กด ‘ตามสัญญาณ’ เพื่อกลับไปดู" : "ยังไม่มีแผนที่ล็อก"}`;
    else if (tracked?.status === "armed") {
      const close = lastMinute?.close;
      const distance = close === undefined ? null : Math.abs(tracked.entry - close);
      detail = `รอแท่ง 1m ปิด${tracked.direction === "up" ? "เหนือ" : "ต่ำกว่า"} ${money(tracked.entry)} · ล่าสุด ${money(close)} · ห่าง ${money(distance)}${state.vwapGate?.ok ? "" : " · VWAP ยังไม่ยืนยัน"} · หมดอายุ ${bkkTime(tracked.expiresAt)}`;
    } else if (tracked?.status === "triggered" || tracked?.status === "tp1") {
      const quote = tracked.detectedQuote;
      detail = `แท่ง 1m ปิดผ่าน ${money(tracked.entry)} และ VWAP ${money(tracked.vwapAtTrigger)} ณ ${bkkTime(tracked.triggeredAt || tracked.statusAt)} · ${tracked.status === "tp1" ? "แตะ TP1 แล้ว · " : ""}${quote ? `Option bid/ask ตอนตรวจพบ ${money(quote.bid)} / ${money(quote.ask)} (quote ${bkkTime(quote.quoteAt)}) · ` : ""}ตรวจราคาใน broker ก่อนตัดสินใจ`;
    } else if (tracked) detail = `${tracked.reason || "แผนสิ้นสุด"} · ${bkkTime(tracked.statusAt)}`;
    else if (!marketOpenNow()) detail = "ตลาดปิด · ไม่สร้างสัญญาณเข้าใหม่";
    else if (state.planDirection === "wait") detail = ["up", "down"].includes(state.signalAssessment?.direction)
      ? "หุ้นมีสัญญาณระยะสั้นแล้ว · รอ Option quote สดและเลือกสัญญาก่อนล็อกแผน"
      : "รอแท่ง 1m+5m ปิดแล้วสดและทิศทางตรงกัน · 15m ห้ามสวนทาง · 1h ใช้ดูบริบท";
    else if (state.optionGate && !state.optionGate.ok) detail = `เลือกสัญญา${state.planDirection === "up" ? " CALL" : " PUT"} ที่ผ่านเกณฑ์ · ${state.optionGate.reasons.join(" · ")}`;
    else if (priceLevels.calculate(barsFor("M5"), state.planDirection)?.wideRisk) detail = "ระยะ Entry ถึง SL กว้างกว่า 3 ATR · ไม่ล็อกแผน รอ setup 5m ที่เสี่ยงแคบลง";
    else if (state.vwapGate?.ready && !state.vwapGate.ok) detail = `VWAP ยังไม่ยืนยันฝั่ง ${state.planDirection === "up" ? "CALL" : "PUT"} · รอแท่ง 1m ใหม่`;
    else detail = state.planBlock || "รอข้อมูลกราฟ 1m / 5m ที่ปิดครบและสด";
    const contractName = (manual ? state.tradePlan : tracked)?.contractSymbol || state.optionGate?.symbol || "ยังไม่พร้อม";
    const vwapValue = tracked?.vwapAtTrigger ?? state.vwapGate?.value;
    const vwapLabel = Number.isFinite(tracked?.vwapAtTrigger) ? `ผ่านตอนเข้า · ${money(vwapValue)}`
      : state.vwapGate?.ready ? `${state.vwapGate.ok ? "ผ่าน" : "รอ"} · ${money(vwapValue)}` : "รอข้อมูล";
    box.className = `plan-workflow ${!manual && active ? tone : "waiting"}`;
    const trendLabel = ["up", "down"].includes(state.signalAssessment?.direction)
      ? state.signalAssessment?.tier === "aligned" ? "3/3 ตรง" : "2/3 เร็ว" : "รอ";
    box.innerHTML = `<div class="workflow-heading"><span class="index">ENTRY WORKFLOW / ราคาหุ้น</span><strong>${esc(title)}</strong></div><p>${esc(detail)}</p><div class="workflow-meta"><span>สัญญา <b>${esc(contractName)}</b></span><span>TF สั้น <b>${trendLabel}</b></span><span>Quote / spread <b>${state.optionGate?.ok ? "ผ่านเกณฑ์" : "รอ/ไม่ผ่าน"}</b></span><span>VWAP วัน <b>${esc(vwapLabel)}</b></span><span>สถานะ <b>${manual ? "ดูจำลอง" : tracked ? active ? "ล็อกระดับ" : "สิ้นสุด" : "ยังไม่ล็อก"}</b></span></div><small>1h เป็นบริบท ไม่ใช่ด่านรอ · VWAP กรองจุดเข้า ไม่ขยับ Entry/SL/TP · ระดับเป็นราคาหุ้น ไม่ใช่ราคา Option หรือคำสั่งซื้อ</small>`;
  }

  function renderLevels() {
    const { indicators, plan, fresh, source, livePlan, recentHistory, tracked } = levelState();
    const status = $("#level-status");
    for (const button of $("#level-side").querySelectorAll("button")) {
      const selected = button.dataset.levelSide === state.levelSide;
      button.classList.toggle("active", selected);
      button.setAttribute("aria-pressed", String(selected));
    }
    $(".level-panel").classList.toggle("preview", Boolean(plan && !livePlan));
    status.className = livePlan ? `level-ready ${plan.direction}` : "level-wait";
    const planStatus = { armed: "เฝ้าทะลุ", triggered: "ผ่านจุดเข้า", tp1: "แตะ TP1", tp2: "แตะ TP2", stopped: "แตะ SL", cancelled: "ยกเลิก", missed: "พลาดจุดเข้า", ambiguous: "ลำดับไม่ชัด", data_gap: "ข้อมูลขาดช่วง", session_end: "จบรอบตลาด" };
    status.textContent = tracked ? `แผน ${tracked.direction === "up" ? "CALL" : "PUT"} · ${planStatus[tracked.status] || "รอข้อมูล"} · 1R ${money(tracked.risk)}`
      : state.levelSide !== "auto" && plan ? "ดูระดับจำลอง · ยังไม่ใช่แผนเข้า"
      : plan?.wideRisk ? `WAIT · 1R กว้างกว่า 3 ATR (${money(plan.risk)})`
      : plan && !marketOpenNow() ? "WAIT · ตลาดปิด · ระดับจากรอบก่อน"
      : plan ? "WAIT · ระดับอ้างอิง 5m ยังไม่ล็อก"
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
      ? `อ้างอิงแท่ง 5m ปิดล่าสุด ${bkkTime(new Date((indicators.basedOn + 300) * 1000))} · ${tracked ? `ระดับล็อกตั้งแต่ ${bkkTime(tracked.createdAt)}` : "ระดับจำลอง ไม่ใช่สัญญาณเข้า"} · ราคาหุ้น ไม่ใช่ option premium · Forecast* เป็นเพียงการลากแนว EMA ต่อ`
      : "รอแท่ง 5m ให้พอคำนวณ · ระดับทั้งหมดอ้างอิงราคาหุ้น ไม่ใช่ราคา premium ของ option";
    renderPlanWorkflow(tracked);
  }

  function renderDataStatus() {
    const open = marketOpenNow();
    const paused = Date.now() < state.quotaPauseUntil;
    $("#refresh-policy").textContent = demo ? "ข้อมูลตัวอย่างในเครื่อง" : paused ? "พักการดึงข้อมูลหลังพบข้อจำกัด API" : !open ? "ตลาดสหรัฐฯ ปิด · หยุดรีเฟรชอัตโนมัติ" : document.hidden ? state.serverMonitorEnabled ? "หน้าเว็บพัก · เซิร์ฟเวอร์สแกนหุ้นเฝ้าอยู่" : "หน้าเว็บพัก · เปิด Push เพื่อสแกนต่อเมื่อปิดหน้า" : "หน้าที่เปิดดู: กราฟ 2 นาที / Option 3 นาที · หุ้นเฝ้า: เซิร์ฟเวอร์";
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
    const lastBar = bars.at(-1), closedAt = chartTime.barEndMs(lastBar, state.chartFrame);
    $("#chart-bar-meta").textContent = lastBar
      ? `ปิดแท่ง ${money(lastBar.close)} · ${state.chartFrame === "D" ? `วันตลาด ${chartTime.formatSessionDate(lastBar.time)}` : `${chartTime.formatBangkok(closedAt / 1000)} เวลาไทย`} · แผน Entry อิง 5m`
      : "ยังไม่มีแท่งที่ปิดครบ · เวลาใต้กราฟเป็นเวลาไทย";
    for (const button of $("#chart-frames").querySelectorAll("button")) button.classList.toggle("active", button.dataset.frame === state.chartFrame);
    if (!bars.length) { container.innerHTML = `<div class="chart-empty">${state.busy ? "กำลังเปิดกราฟ…" : "ยังไม่มีกราฟสำหรับหุ้นนี้"}</div>`; return; }
    const library = window.LightweightCharts;
    if (!library?.createChart) { container.innerHTML = `<div class="chart-empty">กราฟโหลดไม่สำเร็จ กรุณารีเฟรชหน้า</div>`; return; }
    const chart = library.createChart(container, {
      width: container.clientWidth, height: container.clientHeight, layout: { background: { color: "#f8f9f6" }, textColor: "#4b6268", fontFamily: "IBM Plex Mono, monospace", fontSize: 11 },
      grid: { vertLines: { color: "#dce4e0" }, horzLines: { color: "#dce4e0" } },
      rightPriceScale: { borderColor: "#bfceca" },
      timeScale: { borderColor: "#bfceca", timeVisible: state.chartFrame !== "D", tickMarkFormatter: (time, type) => chartTime.axisTick(time, type, state.chartFrame === "D") },
      localization: { locale: "th-TH", timeFormatter: (time) => state.chartFrame === "D" ? chartTime.formatSessionDate(time) : chartTime.formatBangkok(time) },
      crosshair: { vertLine: { color: "#8a4e2a88" }, horzLine: { color: "#8a4e2a88" } },
      handleScroll: { horzTouchDrag: true, vertTouchDrag: false }
    });
    const candles = chart.addSeries(library.CandlestickSeries, { upColor: "#0b817c", downColor: "#9a2635", borderVisible: false, wickUpColor: "#0b817c", wickDownColor: "#9a2635" });
    candles.setData(bars.map(({ time, open, high, low, close }) => ({ time, open, high, low, close })));
    const volume = chart.addSeries(library.HistogramSeries, { priceScaleId: "volume", priceFormat: { type: "volume" }, priceLineVisible: false, lastValueVisible: false });
    volume.setData(bars.map((bar) => ({ time: bar.time, value: bar.volume, color: bar.close >= bar.open ? "#0b817c77" : "#9a263577" })));
    chart.priceScale("volume").applyOptions({ visible: false, scaleMargins: { top: .83, bottom: 0 } });
    const closes = bars.map((bar) => bar.close);
    const frameLabel = { M1: "1m", M5: "5m", M15: "15m", M60: "1h", M240: "4h", D: "1D" }[state.chartFrame];
    [[9, "#0b817c"], [21, "#8a4e2a"]].forEach(([period, color]) => {
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
        addLevel(indicators.projection, "Forecast*", "#a56c43", library.LineStyle?.Dotted ?? 1);
        if (["M1", "M5", "M15"].includes(state.chartFrame)) {
          const startTime = Math.max(bars.at(-1).time, indicators.basedOn + 300);
          const projectionLine = chart.addSeries(library.LineSeries, { color: "#a56c43", lineStyle: library.LineStyle?.Dotted ?? 1, lineWidth: 2, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false });
          projectionLine.setData([{ time: startTime, value: indicators.ema9 }, { time: startTime + 900, value: indicators.projection }]);
        }
      }
      if (plan) {
        addLevel(plan.entry, "ENTRY", livePlan ? "#0b817c" : "#899a9c");
        addLevel(plan.stop, "SL", livePlan ? "#8c1c2b" : "#ac7f82");
        addLevel(plan.tp1, "TP1", livePlan ? "#0b817c" : "#65958f");
        addLevel(plan.tp2, "TP2", livePlan ? "#096b66" : "#527f79");
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
    $("#oi-summary").innerHTML = `<div><small>CALL OI รวม*</small><strong class="call">${rows.length ? count(callTotal) : "—"}</strong></div><div><small>PUT OI รวม*</small><strong class="put">${rows.length ? count(putTotal) : "—"}</strong></div><div><small>PUT / CALL OI*</small><strong>${callTotal ? (putTotal / callTotal).toFixed(2) : "—"}</strong></div>`;
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
    if (!rows.some((row) => row.symbol === state.contractSymbol)) state.contractSymbol = rows[0]?.symbol || (state.busy ? state.contractSymbol : "");
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

  function renderAll() { renderWatchlist(); renderHeader(); renderSignals(); renderDataStatus(); renderOi(); renderContract(); updateTradePlan(); renderChart(); renderLevels(); }

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
    const latestClosedHour = frame === "M60" ? closedBars(cached?.bars, "M60", cached).at(-1) : null;
    const hourNeedsRefresh = frame === "M60" && marketOpenNow() && (!latestClosedHour || Date.now() - chartTime.barEndMs(latestClosedHour, "M60") > 65 * 60_000);
    if (!cached?.stale && !hourNeedsRefresh) return cached;
    try { return await edge("chart", { instrument_id: instrumentId, timespan: frame, refresh: true }); }
    catch (error) { return { ...cached, stale: true, refresh_error: error.message }; }
  }

  async function resolveInstrument(symbol) {
    if (demo) return symbol;
    if (state.focusInstrumentIds[symbol]) return state.focusInstrumentIds[symbol];
    const { data, error } = await state.db.from("instruments").select("id,symbol,asset_type").eq("symbol", symbol).in("asset_type", ["stock", "etf"]).limit(1);
    if (error) return null;
    let id = data?.[0]?.id || null;
    if (!id && state.focusSymbols.includes(symbol)) {
      const assetType = state.focusAssetTypes[symbol] === "etf" ? "etf" : "stock";
      const { data: createdId, error: createError } = await state.db.rpc("api_upsert_instrument", {
        p_asset_type: assetType, p_symbol: symbol, p_display_name: symbol,
        p_exchange: null, p_currency: "USD", p_option_type: null,
        p_strike: null, p_expiry: null, p_multiplier: 1
      });
      if (createError) return null;
      id = createdId || null;
    }
    if (id) state.focusInstrumentIds[symbol] = id;
    return id;
  }

  async function maybeScanFocus() {
    if (!state.user || state.serverMonitorEnabled || state.focusScanBusy || state.busy || document.hidden || !marketOpenNow()) return;
    if (Date.now() < state.quotaPauseUntil) return;
    if (Date.now() - state.focusScanAt < FOCUS_SCAN_SPACING_MS) return;
    const length = state.focusSymbols.length;
    if (length < 2) return;
    let symbol = "";
    for (let offset = 0; offset < length; offset += 1) {
      const index = (state.focusScanCursor + offset) % length;
      const candidate = state.focusSymbols[index];
      if (candidate !== state.symbol && Date.now() - (state.focusSignals[candidate]?.checkedAt || 0) >= 4 * 60_000) {
        symbol = candidate;
        state.focusScanCursor = (index + 1) % length;
        break;
      }
    }
    if (!symbol) return;
    state.focusScanBusy = true;
    state.focusScanAt = Date.now();
    try {
      const instrumentId = await resolveInstrument(symbol);
      if (!instrumentId) {
        state.focusSignals[symbol] = { direction: "wait", fresh: false, missing: true, checkedAt: Date.now(), asOf: 0 };
        renderWatchlist();
        return;
      }
      const minute = await getChart(instrumentId, "M1", symbol);
      const summary = focusSummary({ M1: minute });
      if (minute?.refresh_error) summary.error = minute.refresh_error;
      updateFocusSignal(symbol, summary);
    } catch (error) {
      if (apiError.isRateLimited(error)) state.quotaPauseUntil = Date.now() + 10 * 60_000;
      state.focusSignals[symbol] = { direction: "wait", fresh: false, error: error.message || "แหล่งข้อมูลไม่พร้อม", checkedAt: Date.now(), asOf: 0 };
      renderWatchlist();
    } finally { state.focusScanBusy = false; }
  }

  async function loadHourContext(symbol, instrumentId) {
    if (!instrumentId) return;
    state.lastChartAttemptAt.M60 = Date.now();
    try {
      const hour = await getChart(instrumentId, "M60", symbol);
      if (state.symbol !== symbol || state.instrumentId !== instrumentId) return;
      state.charts.M60 = hour;
      renderSignals();
      if (state.chartFrame === "M60") renderChart();
    } catch (_) { /* Historical 1h context is optional; short-frame signal remains available. */ }
  }

  async function loadSymbol(symbol, { expiry = "", refresh = false, options = true, chartFrames = null, background = false } = {}) {
    const normalized = String(symbol || "").trim().toUpperCase();
    if (!/^[A-Z][A-Z0-9.-]{0,9}$/.test(normalized)) { setStatus("กรอก ticker หุ้นสหรัฐให้ถูกต้อง", true); return; }
    if (state.busy && background) return;
    const requestId = ++state.requestId;
    const symbolChanged = normalized !== state.symbol;
    const frames = symbolChanged ? ["M1"] : Array.isArray(chartFrames) ? chartFrames : refresh ? ["M1"] : [];
    state.symbol = normalized;
    state.busy = true;
    state.lastError = "";
    if (symbolChanged) {
      state.call = null; state.put = null; state.expiry = ""; state.contractSymbol = ""; state.charts = {}; state.levelSide = "auto"; state.vwapGate = null;
      state.tradePlan = readStoredPlan();
      state.side = state.tradePlan?.direction === "down" ? "put" : "call";
      state.contractSymbol = state.tradePlan?.contractSymbol || "";
    }
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
      const errors = results.filter((result) => result.status === "rejected").map((result) => apiError.describe(result.reason));
      for (const result of chartResults) if (result.status === "fulfilled" && result.value?.refresh_error) errors.push(`กราฟ: ${apiError.describe(result.value.refresh_error)}`);
      if (!instrumentId && frames.length && !demo) errors.push("กราฟใช้ได้เฉพาะหุ้นที่อยู่ในรายการ instruments ของ PCC");
      if (errors.some(apiError.isRateLimited)) state.quotaPauseUntil = Date.now() + 10 * 60_000;
      setStatus(errors.length ? `ข้อมูลบางส่วนยังไม่พร้อม: ${[...new Set(errors)].join(" · ")}` : "", errors.length > 0);
    } catch (error) {
      if (requestId !== state.requestId) return;
      if (apiError.isRateLimited(error)) state.quotaPauseUntil = Date.now() + 10 * 60_000;
      setStatus(error.message || "อ่านข้อมูลไม่สำเร็จ", true);
    } finally {
      if (requestId === state.requestId) {
        state.busy = false;
        updateFocusFromSelected();
        renderAll();
        if ((symbolChanged || refresh && Date.now() - (state.lastChartAttemptAt.M60 || 0) >= HOUR_POLL_MS)
          && !frames.includes("M60")) void loadHourContext(normalized, state.instrumentId);
      }
    }
  }

  async function showDesk(user) {
    if (state.user?.id !== user?.id) {
      state.focusSignals = {}; state.focusInstrumentIds = {}; state.symbol = ""; state.instrumentId = null;
      state.call = null; state.put = null; state.charts = {}; state.tradePlan = null; state.vwapGate = null;
    }
    state.user = user;
    $("#auth-shell").hidden = true;
    $("#app-shell").hidden = false;
    $("#account-name").textContent = demo ? "ตัวอย่างในเครื่อง" : user?.email || "PCC member";
    loadFocusPreferences();
    if (!demo) await initMonitor();
    void demoJournal?.mount({
      root: $("#demo-journal"), db: state.db, user,
      context: () => {
        const selected = contracts(state.side).find((row) => row.symbol === state.contractSymbol);
        return {
          symbol: state.symbol, side: state.side,
          contractLabel: selected ? `${state.symbol} ${selected.strike} ${state.side.toUpperCase()}${state.expiry ? ` · ${state.expiry}` : ""}` : ""
        };
      }
    });
    renderWatchlist();
    renderAlerts();
    try {
      const requested = new URLSearchParams(location.search).get("symbol");
      await loadSymbol(focusList.symbol(requested) || state.focusSymbols[0] || "NVDA");
      state.focusScanCursor = state.focusSymbols.length > 1 ? 1 : 0;
      void maybeScanFocus();
    } catch (error) {
      setStatus(error.message || "โหลดรายการหุ้นไม่สำเร็จ", true);
      renderAll();
    }
  }

  function showLogin() {
    demoJournal?.unmount();
    state.requestId++;
    state.user = null;
    state.deviceSubscribed = false; state.serverMonitorEnabled = false; state.serverPauseUntil = 0; state.swRegistration = null; state.monitorError = "";
    state.focusSymbols = []; state.focusAssetTypes = {}; state.focusSignals = {}; state.alerts = []; state.focusInstrumentIds = {};
    state.symbol = ""; state.instrumentId = null; state.call = null; state.put = null; state.charts = {}; state.tradePlan = null; state.vwapGate = null;
    clearChart();
    $("#app-shell").hidden = true;
    $("#auth-shell").hidden = false;
  }

  async function init() {
    if (!priceLevels?.calculate || !priceLevels?.describe || !tradePlan?.reconcile || !chartTime?.completedBars || !focusList?.cleanSymbols || !sessionVwap?.calculate || !demoJournal?.mount) {
      $("#auth-shell").hidden = false;
      $("#auth-message").textContent = "โหลดสูตรคำนวณระดับราคาไม่สำเร็จ กรุณารีเฟรชหน้า";
      return;
    }
    if (demo) { await showDesk({ id: "preview-local", email: "preview@local" }); return; }
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
  $("#sign-out").addEventListener("click", async () => { if (!demo) { if (state.deviceSubscribed) await disablePush(); await state.db.auth.signOut(); } else location.href = location.pathname; });
  $("#focus-form").addEventListener("submit", (event) => {
    event.preventDefault();
    const input = $("#focus-input");
    const symbol = focusList.symbol(input.value);
    const feedback = $("#focus-feedback");
    if (!symbol) { feedback.textContent = "กรอก ticker หุ้นสหรัฐให้ถูกต้อง"; return; }
    if (state.focusSymbols.includes(symbol)) { feedback.textContent = `${symbol} อยู่ในรายการแล้ว`; return; }
    if (state.focusSymbols.length >= focusList.MAX_SYMBOLS) { feedback.textContent = `เฝ้าได้สูงสุด ${focusList.MAX_SYMBOLS} ตัวเพื่อถนอมโควต้า`; return; }
    state.focusSymbols.push(symbol);
    state.focusAssetTypes[symbol] = $("#focus-asset-type").value === "etf" ? "etf" : "stock";
    input.value = "";
    feedback.textContent = `เพิ่ม ${symbol} แล้ว · จะตรวจกราฟเมื่อถึงรอบสแกน`;
    saveFocusPreferences();
    renderWatchlist();
    state.focusScanAt = 0;
    void maybeScanFocus();
  });
  $("#watch-list").addEventListener("click", (event) => {
    const remove = event.target.closest("[data-remove-symbol]");
    if (remove) {
      const symbol = remove.dataset.removeSymbol;
      state.focusSymbols = state.focusSymbols.filter((item) => item !== symbol);
      delete state.focusAssetTypes[symbol];
      delete state.focusSignals[symbol];
      saveFocusPreferences();
      $("#focus-feedback").textContent = `ลบ ${symbol} จากหุ้นเฝ้าเทรดแล้ว · กราฟที่เปิดอยู่ไม่ถูกปิด`;
      renderWatchlist();
      return;
    }
    const button = event.target.closest("[data-symbol]");
    if (button) void loadSymbol(button.dataset.symbol);
  });
  $("#alert-list").addEventListener("click", (event) => { const button = event.target.closest("[data-alert-symbol]"); if (button) void loadSymbol(button.dataset.alertSymbol); });
  $("#notify-button").addEventListener("click", () => { void enablePush(); });
  $("#notify-disable").addEventListener("click", () => { void disablePush(); });
  $("#notify-test").addEventListener("click", async () => {
    const button = $("#notify-test");
    button.disabled = true;
    try {
      const { data, error } = await state.db.functions.invoke("option-desk-monitor", { body: { action: "test" } });
      if (error || data?.error) throw new Error(data?.error || error?.message || "ส่งไม่สำเร็จ");
      state.monitorError = "ส่งทดสอบแล้ว · ดูการแจ้งเตือนบนอุปกรณ์นี้";
    } catch (error) { state.monitorError = `ทดสอบไม่สำเร็จ: ${error.message}`; }
    button.disabled = false; renderAlerts();
  });
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
  $("#option-side").addEventListener("click", (event) => { const button = event.target.closest("[data-side]"); if (button) { state.side = button.dataset.side; state.contractSymbol = ""; renderContract(); updateTradePlan(); renderLevels(); renderChart(); } });
  $("#contract-list").addEventListener("click", (event) => { const button = event.target.closest("[data-contract]"); if (button) { state.contractSymbol = button.dataset.contract; renderContract(); updateTradePlan(); renderLevels(); renderChart(); } });
  $("#oi-rows").addEventListener("click", (event) => {
    const button = event.target.closest("[data-pick-strike]");
    if (!button) return;
    state.side = button.dataset.pickSide;
    const selected = contracts(state.side).find((item) => Number(item.strike) === Number(button.dataset.pickStrike));
    state.contractSymbol = selected?.symbol || "";
    renderContract();
    updateTradePlan(); renderLevels(); renderChart();
    if (matchMedia("(max-width: 760px)").matches) $(".contract-panel").scrollIntoView({ behavior: "smooth" });
  });

  async function maybeAutoRefresh() {
    renderDataStatus();
    renderWatchlist();
    const previousPlanDirection = state.planDirection;
    const previousPlanStatus = state.tradePlan?.status;
    renderSignals();
    updateTradePlan();
    renderLevels();
    if (previousPlanDirection !== state.planDirection || previousPlanStatus !== state.tradePlan?.status) renderChart();
    if (demo || !state.user || !state.symbol || state.busy || document.hidden || !marketOpenNow()) return;
    if (Date.now() < state.quotaPauseUntil) return;
    const now = Date.now();
    if (now - state.lastMonitorReadAt >= 90_000) void readMonitorState();
    const needOptions = now - state.lastOptionAttemptAt >= OPTION_POLL_MS;
    const frames = [];
    if (now - (state.lastChartAttemptAt.M1 || 0) >= MINUTE_POLL_MS) frames.push("M1");
    if (now - (state.lastChartAttemptAt.M60 || 0) >= HOUR_POLL_MS) void loadHourContext(state.symbol, state.instrumentId);
    if (needOptions || frames.length) await loadSymbol(state.symbol, { expiry: state.expiry, options: needOptions, chartFrames: frames, background: true });
    await maybeScanFocus();
  }

  document.addEventListener("pointerdown", () => { state.lastInteractionAt = Date.now(); }, { passive: true });
  document.addEventListener("keydown", () => { state.lastInteractionAt = Date.now(); });
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) { state.lastInteractionAt = Date.now(); state.lastMonitorReadAt = 0; void readMonitorState(); void maybeAutoRefresh(); }
    else renderDataStatus();
  });
  navigator.serviceWorker?.addEventListener("message", (event) => {
    if (event.data?.type === "OPEN_SYMBOL" && focusList.symbol(event.data.symbol)) void loadSymbol(event.data.symbol);
  });
  window.setInterval(() => { void maybeAutoRefresh(); }, 30_000);
  window.setInterval(() => { void maybeScanFocus(); }, 15_000);

  init();
})();
