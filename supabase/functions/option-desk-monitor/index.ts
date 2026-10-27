import { createClient } from "npm:@supabase/supabase-js@2";
import webpush from "npm:web-push@3.6.7";
import { assessChart, shouldAlert } from "../_shared/monitor-signal.mjs";

const url = Deno.env.get("SUPABASE_URL")!;
const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
const admin = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
const jsonHeaders = { "content-type": "application/json; charset=utf-8", "access-control-allow-origin": "*", "access-control-allow-headers": "authorization,content-type,x-monitor-secret" };
const answer = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: jsonHeaders });
const ISO = (ms: number) => new Date(ms).toISOString();

function marketOpen(now: number) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York", weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(new Date(now)).filter((part) => part.type !== "literal").map((part) => [part.type, part.value]));
  const minute = Number(parts.hour) * 60 + Number(parts.minute);
  return !["Sat", "Sun"].includes(parts.weekday) && minute >= 570 && minute < 960;
}

function pushClient() {
  const publicKey = Deno.env.get("OPTION_DESK_VAPID_PUBLIC_KEY");
  const privateKey = Deno.env.get("OPTION_DESK_VAPID_PRIVATE_KEY");
  if (!publicKey || !privateKey) throw new Error("Web Push keys are not configured");
  webpush.setVapidDetails("https://cutiebunny2811.github.io/option-signal-desk/", publicKey, privateKey);
  return webpush;
}

async function sendPush(userId: string, payload: Record<string, unknown>) {
  const { data, error } = await admin.from("option_desk_push_subscriptions")
    .select("id,endpoint,p256dh,auth").eq("user_id", userId);
  if (error) throw error;
  const client = pushClient();
  let sent = 0, failed = 0;
  for (const row of data || []) {
    try {
      await client.sendNotification({ endpoint: row.endpoint, keys: { p256dh: row.p256dh, auth: row.auth } }, JSON.stringify(payload), { TTL: 120 });
      sent++;
    } catch (error) {
      failed++;
      const status = Number((error as { statusCode?: number })?.statusCode);
      if (status === 404 || status === 410) await admin.from("option_desk_push_subscriptions").delete().eq("id", row.id);
      console.error("Push delivery failed", { status, userId, subscriptionId: row.id });
    }
  }
  return { sent, failed };
}

async function scanOne(row: { user_id: string; symbol: string; direction: string; fresh: boolean; as_of: number }, now: number) {
  const { data: instrument, error: instrumentError } = await admin.from("instruments")
    .select("id").eq("user_id", row.user_id).eq("symbol", row.symbol).in("asset_type", ["stock", "etf"]).maybeSingle();
  if (instrumentError) throw instrumentError;
  if (!instrument?.id) throw new Error("หุ้นยังไม่มีใน PCC; เปิดหุ้นนี้ในแอปหนึ่งครั้ง");
  const response = await fetch(`${url}/functions/v1/refresh-stock-prices`, {
    method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${serviceKey}` },
    body: JSON.stringify({ action: "chart", user_id: row.user_id, instrument_id: instrument.id, timespan: "M1", refresh: true }),
  });
  const chart = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`กราฟ ${response.status}: ${String(chart?.error || "แหล่งข้อมูลไม่พร้อม").slice(0, 180)}`);
  if (chart?.refresh_error && /429|quota|rate limit/i.test(String(chart.refresh_error))) throw new Error(String(chart.refresh_error).slice(0, 180));
  const next = assessChart(chart, now);
  const change = shouldAlert(row, next);
  const { error: updateError } = await admin.from("option_desk_monitor_state").update({
    direction: next.direction, tier: next.tier, fresh: next.fresh, price: next.price,
    as_of: next.asOf, checked_at: ISO(now), last_error: chart?.refresh_error ? String(chart.refresh_error).slice(0, 180) : null,
  }).eq("user_id", row.user_id).eq("symbol", row.symbol);
  if (updateError) throw updateError;
  if (!change) return { symbol: row.symbol, direction: next.direction, notified: false };
  const { error: eventError } = await admin.from("option_desk_monitor_events").insert({
    user_id: row.user_id, symbol: row.symbol, direction: next.direction, tier: next.tier, as_of: next.asOf,
  });
  if (eventError) {
    if (eventError.code === "23505") return { symbol: row.symbol, direction: next.direction, notified: false };
    throw eventError;
  }
  const side = next.direction === "up" ? "CALL" : "PUT";
  const delivery = await sendPush(row.user_id, {
    title: `${row.symbol} · เริ่มเฝ้า ${side}`,
    body: `${next.tier === "aligned" ? "แท่งปิด 1m/5m/15m ตรงกัน" : "แท่งปิด 1m+5m ตรงกัน"} · ยังไม่ใช่จุดเข้า ตรวจสัญญาก่อน`,
    tag: `watch:${row.symbol}:${next.asOf}`, symbol: row.symbol, url: `/?symbol=${encodeURIComponent(row.symbol)}`,
  });
  return { symbol: row.symbol, direction: next.direction, notified: delivery.sent > 0, delivery };
}

async function runMonitor() {
  const now = Date.now();
  if (!marketOpen(now)) return answer({ market: "closed", scanned: 0 });
  const ownerId = Deno.env.get("OPTIONS_OPRA_OWNER_USER_ID") || Deno.env.get("OPTIONS_EOD_OWNER_USER_ID");
  if (!ownerId) return answer({ error: "Market-data owner is not configured" }, 503);
  const { data: settings, error: settingsError } = await admin.from("option_desk_monitor_settings")
    .select("user_id,symbols,pause_until").eq("user_id", ownerId).eq("enabled", true).maybeSingle();
  if (settingsError) throw settingsError;
  if (!settings?.symbols?.length) return answer({ market: "open", scanned: 0, reason: "disabled" });
  if (settings.pause_until && Date.parse(settings.pause_until) > now) return answer({ market: "open", scanned: 0, reason: "quota_pause" });
  const { count, error: countError } = await admin.from("option_desk_push_subscriptions")
    .select("id", { head: true, count: "exact" }).eq("user_id", ownerId);
  if (countError) throw countError;
  if (!count) return answer({ market: "open", scanned: 0, reason: "no_devices" });
  const { data: due, error: dueError } = await admin.from("option_desk_monitor_state")
    .select("user_id,symbol,direction,fresh,as_of,next_scan_at")
    .eq("user_id", ownerId).in("symbol", settings.symbols).lte("next_scan_at", ISO(now))
    .order("next_scan_at", { ascending: true }).limit(2);
  if (dueError) throw dueError;
  const results = [];
  for (const row of due || []) {
    const { data: claimed, error: claimError } = await admin.from("option_desk_monitor_state")
      .update({ next_scan_at: ISO(now + 3 * 60_000) })
      .eq("user_id", row.user_id).eq("symbol", row.symbol).eq("next_scan_at", row.next_scan_at)
      .select("user_id").maybeSingle();
    if (claimError) throw claimError;
    if (!claimed) continue;
    try { results.push(await scanOne(row, now)); }
    catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const rateLimited = /429|quota|rate limit/i.test(message);
      await admin.from("option_desk_monitor_state").update({
        next_scan_at: ISO(now + (rateLimited ? 15 : 5) * 60_000), last_error: message.slice(0, 180),
        fresh: false, checked_at: ISO(now),
      }).eq("user_id", row.user_id).eq("symbol", row.symbol);
      results.push({ symbol: row.symbol, error: message });
      if (rateLimited) {
        await admin.from("option_desk_monitor_settings").update({ pause_until: ISO(now + 15 * 60_000) }).eq("user_id", row.user_id);
        break;
      }
    }
  }
  return answer({ market: "open", scanned: results.length, results });
}

async function testPush(request: Request) {
  const bearer = request.headers.get("authorization") || "";
  const client = createClient(url, anonKey, { global: { headers: { authorization: bearer } }, auth: { persistSession: false } });
  const { data: { user }, error } = await client.auth.getUser();
  if (error || !user) return answer({ error: "เข้าสู่ระบบก่อน" }, 401);
  const { data: settings, error: settingsError } = await admin.from("option_desk_monitor_settings")
    .select("last_test_at").eq("user_id", user.id).maybeSingle();
  if (settingsError) throw settingsError;
  if (settings?.last_test_at && Date.now() - Date.parse(settings.last_test_at) < 60_000) return answer({ error: "ทดสอบได้ทุก 1 นาที" }, 429);
  const delivery = await sendPush(user.id, {
    title: "Option Desk · ทดสอบแจ้งเตือน", body: "แจ้งเตือนถึงอุปกรณ์นี้แล้ว · สัญญาณจริงจะส่งเมื่อทิศทางเปลี่ยนและตลาดเปิด",
    tag: "option-desk-test", url: "/",
  });
  if (!delivery.sent) return answer({ error: "ยังส่งไม่ถึงอุปกรณ์ ตรวจการอนุญาตแจ้งเตือน", delivery }, 502);
  await admin.from("option_desk_monitor_settings").update({ last_test_at: new Date().toISOString() }).eq("user_id", user.id);
  return answer({ ok: true, delivery });
}

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: jsonHeaders });
  if (request.method !== "POST") return answer({ error: "Method not allowed" }, 405);
  try {
    const body = await request.json().catch(() => ({}));
    if (body?.action === "test") return await testPush(request);
    if (body?.action !== "scan") return answer({ error: "Unknown action" }, 400);
    const token = Deno.env.get("OPTION_DESK_MONITOR_TOKEN");
    if (!token || request.headers.get("x-monitor-secret") !== token) return answer({ error: "Unauthorized" }, 401);
    return await runMonitor();
  } catch (error) {
    console.error("Option Desk monitor error", error);
    return answer({ error: error instanceof Error ? error.message : "Monitor failed" }, 500);
  }
});
