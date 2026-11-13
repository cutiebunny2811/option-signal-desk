import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const schedule = readFileSync(new URL("../supabase/option_desk_monitor_schedule.sql", import.meta.url), "utf8");
const monitor = readFileSync(new URL("../supabase/functions/option-desk-monitor/index.ts", import.meta.url), "utf8");

test("server monitor leaves room between scans and bounds slow requests", () => {
  assert.match(schedule, /'\*\/2 \* \* \* \*'/);
  assert.match(schedule, /timeout_milliseconds := 45000/);
  assert.match(monitor, /\.limit\(2\)/);
  assert.match(monitor, /next_scan_at: ISO\(now \+ 3 \* 60_000\)/);
});
