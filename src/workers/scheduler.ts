import cron from "node-cron";
import { getSettings } from "../routes/settings.js";
import { Collections } from "../firestore.js";
import { syncVendor } from "../services/pipeline.js";
import { runDriftCheckAllEnabledVendors } from "../services/drift.js";
import { withShipTurtleAuthRetry } from "../services/shipturtle-auth.js";
import { log } from "../lib/log.js";
import type { VendorRecord } from "../types.js";
import { getCurrentJob } from "../routes/sync.js";

let syncTask: cron.ScheduledTask | null = null;
let driftTask: cron.ScheduledTask | null = null;
let running = false;
let driftRunning = false;

async function tick() {
  if (running) return;
  if (getCurrentJob()?.status === "running") return;
  const s = await getSettings();
  if (!s.globalSyncEnabled) return;
  if (!s.shipturtleToken || !s.shopifyAdminToken || !s.shopifyStoreDomain) return;
  const snap = await Collections.vendors.where("syncEnabled", "==", true).get();
  const vendors = snap.docs
    .map((d) => d.data() as VendorRecord)
    .filter((v) => v.brandId && v.vendorType === "Using vendor sync");
  if (vendors.length === 0) return;
  running = true;
  await log({ level: "info", message: `Cron tick — running ${vendors.length} vendor(s)`, step: "system" });
  try {
    for (const v of vendors) {
      try {
        await withShipTurtleAuthRetry(getSettings, () => syncVendor(v));
      } catch (e: any) {
        await log({ level: "error", message: `Cron: vendor ${v.title} failed: ${e.message}`, vendorId: v.id, step: "system" });
      }
    }
  } finally {
    running = false;
  }
}

async function driftTick() {
  if (driftRunning) return;
  if (getCurrentJob()?.status === "running") return; // don't fight the sync job
  const s = await getSettings();
  if (!s.globalSyncEnabled) return;
  if (!s.shipturtleToken) return;
  driftRunning = true;
  try {
    await runDriftCheckAllEnabledVendors();
  } catch (e: any) {
    await log({ level: "error", message: `Drift cron crashed: ${e.message}`, step: "system" });
  } finally {
    driftRunning = false;
  }
}

export function startScheduler() {
  const syncExpr = process.env.SYNC_CRON || "*/30 * * * *";
  const driftExpr = process.env.DRIFT_CRON || "15 * * * *"; // every hour at :15 by default
  syncTask?.stop();
  driftTask?.stop();
  syncTask = cron.schedule(syncExpr, () => {
    tick().catch((e) => log({ level: "error", message: `Scheduler crashed: ${e.message}`, step: "system" }));
  });
  driftTask = cron.schedule(driftExpr, () => {
    driftTick().catch((e) => log({ level: "error", message: `Drift scheduler crashed: ${e.message}`, step: "system" }));
  });
  // eslint-disable-next-line no-console
  console.log(`[scheduler] sync="${syncExpr}" drift="${driftExpr}"`);
}
