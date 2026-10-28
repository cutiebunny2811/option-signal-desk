(function (root, factory) {
  "use strict";
  const api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (root) root.OptionDeskDemoJournal = api;
})(typeof globalThis === "undefined" ? null : globalThis, function () {
  "use strict";

  const TABLE = "option_desk_demo_trades";
  const symbolPattern = /^[A-Z][A-Z0-9.-]{0,9}$/;
  const html = (value) => String(value ?? "").replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]);
  const money = (value) => `${Number(value) < 0 ? "−" : Number(value) > 0 ? "+" : ""}$${Math.abs(Number(value) || 0).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  const dollars = (value) => `$${Number(value).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  const dateTime = (value) => new Date(value).toLocaleString("th-TH", { timeZone: "Asia/Bangkok", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) + " น.";
  const localInputTime = (value = Date.now()) => {
    const date = new Date(value);
    const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Bangkok", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(date);
    const part = (name) => parts.find((item) => item.type === name)?.value || "00";
    return `${part("year")}-${part("month")}-${part("day")}T${part("hour")}:${part("minute")}`;
  };
  const bangkokTime = (value) => /^\d{4}-\d\d-\d\dT\d\d:\d\d(?::\d\d)?$/.test(String(value)) ? `${value}${String(value).length === 16 ? ":00" : ""}+07:00` : value;

  function duration(milliseconds) {
    if (!Number.isFinite(milliseconds) || milliseconds < 0) return "—";
    const minutes = Math.floor(milliseconds / 60_000);
    const hours = Math.floor(minutes / 60);
    const days = Math.floor(hours / 24);
    return days ? `${days} วัน ${hours % 24} ชม.` : hours ? `${hours} ชม. ${minutes % 60} น.` : `${minutes} นาที`;
  }

  function result(row) {
    const buyTotal = Number(row.buy_total);
    const net = Math.round((Number(row.sell_total) - buyTotal - Number(row.fees_total || 0)) * 100) / 100;
    const heldMs = Date.parse(row.closed_at) - Date.parse(row.opened_at);
    return { net, heldMs, returnPercent: buyTotal > 0 ? net / buyTotal * 100 : null };
  }

  function percent(value) {
    if (!Number.isFinite(value)) return "—";
    const rounded = Math.round(value * 10) / 10;
    return `${rounded > 0 ? "+" : rounded < 0 ? "−" : ""}${Math.abs(rounded).toFixed(1)}%`;
  }

  function summarize(rows, followedOnly = true) {
    const included = (Array.isArray(rows) ? rows : []).filter((row) => !row.voided_at && (!followedOnly || row.followed_signal));
    const outcomes = included.map(result);
    const wins = outcomes.filter((item) => item.net > 0).length;
    const losses = outcomes.filter((item) => item.net < 0).length;
    const breakeven = outcomes.length - wins - losses;
    return {
      count: outcomes.length, wins, losses, breakeven,
      net: Math.round(outcomes.reduce((sum, item) => sum + item.net, 0) * 100) / 100,
      winRate: wins + losses ? wins / (wins + losses) * 100 : null,
      averageHoldMs: outcomes.length ? outcomes.reduce((sum, item) => sum + item.heldMs, 0) / outcomes.length : null
    };
  }

  function pageRows(rows, { followedOnly = true, query = "", page = 0, pageSize = 10 } = {}) {
    const term = String(query).trim().toUpperCase();
    const size = Math.max(1, Math.floor(Number(pageSize) || 10));
    const visible = (Array.isArray(rows) ? rows : [])
      .filter((row) => !row.voided_at && (!followedOnly || row.followed_signal))
      .filter((row) => !term || `${row.underlying_symbol || ""} ${row.contract_label || ""} ${row.option_side || ""}`.toUpperCase().includes(term))
      .sort((a, b) => Date.parse(b.closed_at) - Date.parse(a.closed_at));
    const pages = Math.max(1, Math.ceil(visible.length / size));
    const currentPage = Math.min(Math.max(0, Math.floor(Number(page) || 0)), pages - 1);
    const start = currentPage * size;
    return { rows: visible.slice(start, start + size), total: visible.length, page: currentPage, pages, start };
  }

  function validate(input) {
    const contractLabel = String(input.contract_label || "").trim().replace(/\s+/g, " ");
    const symbol = String(input.underlying_symbol || "").trim().toUpperCase();
    const side = String(input.option_side || "").toLowerCase();
    const contracts = Number(input.contracts);
    const buy = Number(input.buy_total), sell = Number(input.sell_total), fees = Number(input.fees_total || 0);
    const opened = Date.parse(bangkokTime(input.opened_at)), closed = Date.parse(bangkokTime(input.closed_at));
    if (!contractLabel || contractLabel.length > 80) throw new Error("กรอกชื่อสัญญาไม่เกิน 80 ตัวอักษร");
    if (!symbolPattern.test(symbol)) throw new Error("กรอก ticker หุ้นให้ถูกต้อง");
    if (!["call", "put"].includes(side)) throw new Error("เลือก CALL หรือ PUT");
    if (!Number.isInteger(contracts) || contracts < 1 || contracts > 100000) throw new Error("จำนวนสัญญาต้องเป็นจำนวนเต็มมากกว่า 0");
    if (input.buy_total === "" || input.sell_total === "" || ![buy, sell, fees].every((value) => Number.isFinite(value) && value >= 0 && value <= 1e12)) throw new Error("ยอดซื้อ ยอดขาย และค่าธรรมเนียมต้องเป็นตัวเลขไม่ติดลบ");
    if (!Number.isFinite(opened) || !Number.isFinite(closed) || closed < opened) throw new Error("เวลาปิดต้องไม่ก่อนเวลาเปิด");
    const notes = String(input.notes || "").trim();
    if (notes.length > 500) throw new Error("โน้ตยาวเกิน 500 ตัวอักษร");
    return {
      contract_label: contractLabel, underlying_symbol: symbol, option_side: side, contracts,
      buy_total: Math.round(buy * 100) / 100, sell_total: Math.round(sell * 100) / 100,
      fees_total: Math.round(fees * 100) / 100,
      opened_at: new Date(opened).toISOString(), closed_at: new Date(closed).toISOString(),
      followed_signal: Boolean(input.followed_signal), notes
    };
  }

  function csv(rows) {
    const fields = ["contract_label", "underlying_symbol", "option_side", "contracts", "buy_total", "sell_total", "fees_total", "net_pnl", "opened_at", "closed_at", "followed_signal", "signal_tier", "notes"];
    const quote = (value) => `"${String(value ?? "").replace(/"/g, '""')}"`;
    return "\uFEFF" + [fields.join(","), ...(Array.isArray(rows) ? rows : []).filter((row) => !row.voided_at).map((row) => fields.map((field) => quote(field === "net_pnl" ? result(row).net : row[field])).join(","))].join("\r\n");
  }

  let current = null;
  async function mount({ root, db, user, context }) {
    if (!root || !user?.id) return;
    const key = `option-desk:demo-trades:v1:${user.id}`;
    const readLocal = () => {
      try { const value = JSON.parse(localStorage.getItem(key) || "[]"); return Array.isArray(value) ? value.filter((row) => row?.user_id === user.id && typeof row.id === "string") : []; }
      catch (_) { return []; }
    };
    const state = { rows: readLocal(), mode: "loading", filter: "followed", query: "", page: 0, expanded: new Set(), saving: false };
    current = state;
    const find = (selector) => root.querySelector(selector);
    const saveLocal = () => { try { localStorage.setItem(key, JSON.stringify(state.rows)); return true; } catch (_) { return false; } };
    const status = (message, error = false) => { find("#demo-journal-status").textContent = message; find("#demo-journal-status").classList.toggle("error", error); };

    function render() {
      const followedOnly = state.filter === "followed";
      const stats = summarize(state.rows, followedOnly);
      find("#demo-summary").innerHTML = `<div class="demo-metric demo-net"><small>กำไรสุทธิ · ${followedOnly ? "ตามแอป" : "ทั้งหมด"}</small><strong class="${stats.net >= 0 ? "positive" : "negative"}">${stats.count ? money(stats.net) : "—"}</strong></div><div class="demo-metric"><small>ปิดแล้ว</small><strong>${stats.count}</strong></div><div class="demo-metric"><small>ชนะ / แพ้</small><strong><span class="positive">${stats.wins}</span> / <span class="negative">${stats.losses}</span></strong></div><div class="demo-metric"><small>ชนะต่อรายการที่มีผล</small><strong>${stats.winRate === null ? "—" : `${stats.winRate.toFixed(1)}%`}</strong></div><div class="demo-metric"><small>ถือเฉลี่ย</small><strong>${stats.averageHoldMs === null ? "—" : duration(stats.averageHoldMs)}</strong></div>`;
      for (const button of root.querySelectorAll("[data-demo-filter]")) {
        const selected = button.dataset.demoFilter === state.filter;
        button.classList.toggle("active", selected);
        button.setAttribute("aria-pressed", String(selected));
      }
      const listing = pageRows(state.rows, { followedOnly, query: state.query, page: state.page });
      state.page = listing.page;
      find("#demo-list").innerHTML = listing.rows.length ? listing.rows.map((row) => {
        const { net, heldMs, returnPercent } = result(row);
        const expanded = state.expanded.has(row.id);
        return `<article class="demo-row${expanded ? " is-expanded" : ""}"><button type="button" class="demo-mobile-summary" data-demo-expand="${html(row.id)}" aria-expanded="${expanded}" aria-controls="demo-more-${html(row.id)}"><span class="demo-mobile-contract"><strong>${html(row.contract_label)}</strong><small>${dateTime(row.closed_at)} · ${row.contracts} สัญญา</small></span><span class="demo-mobile-result"><strong class="${net >= 0 ? "positive" : "negative"}">${money(net)}</strong><small><span class="${net >= 0 ? "positive" : "negative"}">${percent(returnPercent)}</span> · รายละเอียด ${expanded ? "−" : "+"}</small></span></button><div class="demo-row-more" id="demo-more-${html(row.id)}"><div class="demo-contract"><strong>${html(row.contract_label)}</strong><small>${html(row.underlying_symbol)} · <span class="${row.option_side}">${row.option_side.toUpperCase()}</span> · ${row.contracts} สัญญา${row.followed_signal ? " · ตามแอป" : ""}</small></div><div class="demo-amount"><small>ซื้อ / ขายรวม</small><strong>${dollars(row.buy_total)} <span>→</span> ${dollars(row.sell_total)}</strong></div><div class="demo-outcome"><small>สุทธิหลังค่าธรรมเนียม</small><strong class="${net >= 0 ? "positive" : "negative"}">${money(net)}</strong><small class="demo-return"><span class="${net >= 0 ? "positive" : "negative"}">ผลตอบแทน ${percent(returnPercent)}</span></small></div><div class="demo-hold"><small>เวลาถือ</small><strong>${duration(heldMs)}</strong><small>${dateTime(row.closed_at)}</small></div><div class="demo-row-actions"><button type="button" data-demo-edit="${html(row.id)}">แก้ไข</button><button type="button" data-demo-void="${html(row.id)}">ยกเลิก</button></div></div></article>`;
      }).join("") : `<p class="demo-empty">${state.query ? "ไม่พบรายการที่ตรงกับคำค้น · ลอง ticker หรือ strike อื่น" : "ยังไม่มีรายการที่ปิดแล้วในมุมมองนี้ · กด “จด Demo trade” เพื่อเริ่มเก็บผลจริงจากพอร์ตทดลอง"}</p>`;
      find("#demo-list-count").textContent = listing.total ? `${listing.start + 1}–${listing.start + listing.rows.length} จาก ${listing.total} รายการ` : "0 รายการ";
      find("#demo-pagination").hidden = listing.pages <= 1;
      find("#demo-page-status").textContent = `หน้า ${listing.page + 1}/${listing.pages}`;
      find("#demo-page-prev").disabled = listing.page === 0;
      find("#demo-page-next").disabled = listing.page >= listing.pages - 1;
      find("#demo-storage").textContent = state.mode === "remote" ? "ซิงก์ Supabase" : state.mode === "loading" ? "กำลังตรวจที่เก็บ" : "เก็บในเครื่อง · สำรอง CSV";
    }

    async function sync() {
      if (!db || !current || current !== state) { state.mode = "local"; render(); return; }
      status("กำลังซิงก์ประวัติ Demo…");
      try {
        const remote = [];
        for (let from = 0; ; from += 500) {
          const { data, error } = await db.from(TABLE).select("*").order("closed_at", { ascending: false }).range(from, from + 499);
          if (error) throw error;
          remote.push(...data);
          if (data.length < 500) break;
        }
        if (current !== state) return;
        const merged = new Map(remote.map((row) => [row.id, row]));
        const pending = [];
        for (const row of state.rows) {
          const server = merged.get(row.id);
          if (!server || Date.parse(row.updated_at) > Date.parse(server.updated_at)) { merged.set(row.id, row); pending.push(row); }
        }
        if (pending.length) {
          const { error } = await db.from(TABLE).upsert(pending, { onConflict: "id" });
          if (error) throw error;
        }
        state.rows = [...merged.values()];
        saveLocal();
        state.mode = "remote";
        status(`ซิงก์แล้ว ${state.rows.filter((row) => !row.voided_at).length} รายการ · ใช้บัญชี PCC เดียวกัน`);
      } catch (_) {
        state.mode = "local";
        status("ซิงก์ Supabase ไม่สำเร็จหรือตารางยังไม่พร้อม · บันทึกในเบราว์เซอร์นี้ก่อน และกด CSV สำรองไว้", true);
      }
      render();
    }

    function openForm(row = null) {
      const form = find("#demo-form");
      form.reset();
      const info = context?.() || {};
      const side = row?.option_side || info.side || "call";
      const label = row?.contract_label || info.contractLabel || "";
      form.elements.namedItem("id").value = row?.id || "";
      form.elements.namedItem("contract_label").value = label;
      form.elements.namedItem("underlying_symbol").value = row?.underlying_symbol || info.symbol || "";
      form.elements.namedItem("option_side").value = side;
      form.elements.namedItem("contracts").value = row?.contracts || 1;
      form.elements.namedItem("buy_total").value = row?.buy_total ?? "";
      form.elements.namedItem("sell_total").value = row?.sell_total ?? "";
      form.elements.namedItem("fees_total").value = row?.fees_total ?? 0;
      form.elements.namedItem("opened_at").value = localInputTime(row?.opened_at || Date.now());
      form.elements.namedItem("closed_at").value = localInputTime(row?.closed_at || Date.now());
      form.elements.namedItem("followed_signal").checked = row?.followed_signal ?? false;
      form.elements.namedItem("notes").value = row?.notes || "";
      find("#demo-form-title").textContent = row ? "แก้ไขรายการ Demo" : "จดรายการที่ปิดแล้ว";
      form.hidden = false;
      form.scrollIntoView({ behavior: "smooth", block: "nearest" });
      form.elements.namedItem("contract_label").focus();
    }

    const importer = globalThis.OptionDeskImageImport;
    const importPanel = find("#demo-image-import");
    const importToggle = find("#demo-import-toggle");
    const importStatus = find("#demo-import-status");
    const importResult = find("#demo-import-result");
    const imageFiles = { buy: null, sell: null };
    let scanBusy = false, scanQueued = false;
    const setImportStatus = (message, isError = false) => {
      importStatus.textContent = message;
      importStatus.classList.toggle("error", isError);
    };
    const setImportVisible = (visible) => {
      importPanel.hidden = !visible;
      importToggle.setAttribute("aria-expanded", String(visible));
      if (visible) importPanel.scrollIntoView({ behavior: "smooth", block: "nearest" });
    };
    const setImageFile = (side, file) => {
      if (!file || !["image/png", "image/jpeg", "image/webp"].includes(file.type)) { setImportStatus("รองรับภาพ PNG, JPG หรือ WebP เท่านั้น", true); return; }
      if (file.size > 10 * 1024 * 1024) { setImportStatus("รูปใหญ่เกิน 10 MB · ลองภาพที่เล็กลง", true); return; }
      imageFiles[side] = file;
      const slot = find(`[data-demo-image="${side}"]`);
      slot.classList.add("ready");
      find(`#demo-${side}-file`).textContent = file.name || "รูปที่วางจากคลิปบอร์ด";
      importResult.hidden = true;
      if (imageFiles.buy && imageFiles.sell) void scanImages();
      else setImportStatus(`ได้รูป${side === "buy" ? "ซื้อ" : "ขาย"}แล้ว · เพิ่มรูปอีกฝั่งเพื่ออ่านอัตโนมัติ`);
    };
    async function scanImages() {
      if (scanBusy) { scanQueued = true; return; }
      if (!importer) { setImportStatus("ตัวอ่านภาพไม่พร้อม · รีโหลดหน้าแล้วลองใหม่", true); return; }
      scanBusy = true;
      const buyFile = imageFiles.buy, sellFile = imageFiles.sell;
      setImportStatus("กำลังเตรียมตัวอ่านภาพ… ครั้งแรกอาจใช้เวลาสักครู่");
      try {
        const [buyText, sellText] = await importer.recognizeFiles([buyFile, sellFile], (message) => setImportStatus(message));
        if (imageFiles.buy !== buyFile || imageFiles.sell !== sellFile || current !== state) return;
        const trade = importer.buildClosedTrade(
          importer.parseFilledImageText(buyText, "buy"),
          importer.parseFilledImageText(sellText, "sell")
        );
        openForm();
        const form = find("#demo-form");
        for (const [name, value] of Object.entries(trade)) {
          const field = form.elements.namedItem(name);
          if (field && field.type !== "checkbox") field.value = value;
        }
        form.elements.namedItem("followed_signal").checked = false;
        const gross = trade.sell_total - trade.buy_total;
        importResult.innerHTML = `<div><small>สัญญา</small><strong>${html(trade.contract_label)} · ${trade.contracts} สัญญา</strong></div><div><small>ซื้อรวม</small><strong>${dollars(trade.buy_total)}</strong></div><div><small>ขายรวม</small><strong>${dollars(trade.sell_total)}</strong></div><div><small>กำไรก่อนค่าธรรมเนียม</small><strong class="${gross >= 0 ? "positive" : "negative"}">${money(gross)}</strong></div><div class="result-note"><strong>กรุณาตรวจฟอร์มด้านล่างก่อนบันทึก</strong> · เวลาแปลงเป็นไทยแล้ว · ค่าธรรมเนียมยังเป็น 0 เพราะภาพไม่แสดง · ติ๊ก “ตามแอป” เองหากเข้าตามสัญญาณจริง</div>`;
        importResult.hidden = false;
        setImportStatus("อ่านครบแล้ว · เติมฟอร์มให้ตรวจและกดบันทึก 1 ครั้ง ยังไม่ได้เก็บลงสถิติ");
        form.scrollIntoView({ behavior: "smooth", block: "nearest" });
      } catch (error) {
        if (current === state) setImportStatus(`อ่านรูปไม่สำเร็จ: ${error.message} · ระบบอาจอ่านอักษรผิด ลองแนบใหม่หรือจดเอง`, true);
      } finally {
        scanBusy = false;
        if (scanQueued) { scanQueued = false; if (imageFiles.buy && imageFiles.sell) void scanImages(); }
      }
    }
    importToggle.onclick = () => setImportVisible(importPanel.hidden);
    find("#demo-import-close").onclick = () => setImportVisible(false);
    for (const side of ["buy", "sell"]) {
      const slot = find(`[data-demo-image="${side}"]`);
      const input = find(`#demo-${side}-image`);
      input.onchange = () => { if (input.files?.[0]) setImageFile(side, input.files[0]); };
      slot.onkeydown = (event) => { if (event.target === slot && ["Enter", " "].includes(event.key)) { event.preventDefault(); input.click(); } };
      slot.onpaste = (event) => {
        const item = [...(event.clipboardData?.items || [])].find((entry) => entry.type.startsWith("image/"));
        if (!item) return;
        event.preventDefault();
        const file = item.getAsFile();
        if (file) setImageFile(side, file);
      };
      slot.ondragover = (event) => { event.preventDefault(); slot.classList.add("dragover"); };
      slot.ondragleave = () => slot.classList.remove("dragover");
      slot.ondrop = (event) => { event.preventDefault(); slot.classList.remove("dragover"); if (event.dataTransfer?.files?.[0]) setImageFile(side, event.dataTransfer.files[0]); };
    }

    find("#demo-add").onclick = () => openForm();
    const shortcut = document.querySelector("#demo-shortcut");
    if (shortcut) shortcut.onclick = () => openForm();
    find("#demo-cancel").onclick = () => { find("#demo-form").hidden = true; status(""); };
    find("#demo-sync").onclick = () => { void sync(); };
    find("#demo-filters").onclick = (event) => {
      const button = event.target.closest("[data-demo-filter]");
      if (!button) return;
      state.filter = button.dataset.demoFilter;
      state.page = 0;
      state.expanded.clear();
      render();
    };
    find("#demo-search").oninput = (event) => { state.query = event.target.value; state.page = 0; state.expanded.clear(); render(); };
    for (const [selector, direction] of [["#demo-page-prev", -1], ["#demo-page-next", 1]]) {
      find(selector).onclick = () => { state.page += direction; state.expanded.clear(); render(); find("#demo-list-head").scrollIntoView({ behavior: "smooth", block: "start" }); };
    }
    find("#demo-list").onclick = (event) => {
      const expand = event.target.closest("[data-demo-expand]");
      if (expand) {
        const id = expand.dataset.demoExpand;
        const expanded = !state.expanded.has(id);
        if (expanded) state.expanded.add(id); else state.expanded.delete(id);
        expand.setAttribute("aria-expanded", String(expanded));
        expand.querySelector(".demo-mobile-result small").textContent = `รายละเอียด ${expanded ? "−" : "+"}`;
        expand.closest(".demo-row").classList.toggle("is-expanded", expanded);
        return;
      }
      const edit = event.target.closest("[data-demo-edit]");
      if (edit) { const row = state.rows.find((item) => item.id === edit.dataset.demoEdit); if (row) openForm(row); return; }
      const remove = event.target.closest("[data-demo-void]");
      if (!remove) return;
      const row = state.rows.find((item) => item.id === remove.dataset.demoVoid);
      if (!row || !confirm(`ยกเลิกรายการ ${row.contract_label}? รายการจะถูกซ่อนและไม่นับในสถิติ แต่ยังเก็บแถวไว้ในฐานข้อมูล`)) return;
      row.voided_at = new Date().toISOString(); row.updated_at = row.voided_at;
      if (!saveLocal()) status("บันทึกในเครื่องไม่สำเร็จ · โปรดส่งออก CSV", true);
      render();
      if (state.mode === "remote") void sync();
    };
    find("#demo-export").onclick = () => {
      const blob = new Blob([csv(state.rows)], { type: "text/csv;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url; link.download = `option-desk-demo-${new Date().toISOString().slice(0, 10)}.csv`;
      document.body.append(link); link.click(); link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    };
    find("#demo-form").onsubmit = async (event) => {
      event.preventDefault();
      if (state.saving) return;
      const form = event.currentTarget;
      const raw = Object.fromEntries(new FormData(form));
      raw.followed_signal = form.elements.namedItem("followed_signal").checked;
      let values;
      try { values = validate(raw); } catch (error) { status(error.message, true); return; }
      const previous = state.rows.find((item) => item.id === raw.id);
      const now = new Date().toISOString();
      const row = {
        ...previous, ...values, id: previous?.id || crypto.randomUUID(), user_id: user.id,
        signal_tier: values.followed_signal ? "self_reported" : null,
        created_at: previous?.created_at || now, updated_at: now, voided_at: null
      };
      state.saving = true;
      state.rows = [row, ...state.rows.filter((item) => item.id !== row.id)];
      const localSaved = saveLocal();
      if (!localSaved) status("บันทึกในเครื่องไม่สำเร็จ · โปรดส่งออก CSV ก่อนออกจากหน้า", true);
      form.hidden = true;
      if (!values.followed_signal) state.filter = "all";
      state.page = 0;
      state.expanded.clear();
      setImportVisible(false);
      imageFiles.buy = null; imageFiles.sell = null;
      for (const side of ["buy", "sell"]) {
        find(`#demo-${side}-image`).value = "";
        find(`#demo-${side}-file`).textContent = "คลิกเลือกภาพ หรือวางด้วย Ctrl+V";
        find(`[data-demo-image="${side}"]`).classList.remove("ready");
      }
      importResult.hidden = true;
      setImportStatus("เลือกหรือวางรูปทั้งสองใบ แล้วแอปจะเติมฟอร์มให้ตรวจอีกครั้งก่อนบันทึก");
      render();
      if (state.mode === "remote") await sync();
      if (state.mode !== "remote") status(localSaved ? "บันทึกในเครื่องแล้ว · กด CSV สำรองข้อมูลไว้จนกว่าจะเชื่อม Supabase" : "ยังไม่ได้บันทึกถาวร · โปรดส่งออก CSV ก่อนออกจากหน้า", !localSaved);
      state.saving = false;
    };
    render();
    void sync();
  }

  function unmount() { current = null; }
  return { duration, result, percent, summarize, pageRows, validate, csv, mount, unmount };
});
