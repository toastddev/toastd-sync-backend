import { Collections } from "../firestore.js";
import { log } from "../lib/log.js";
import { deriveMappingStatus, listAllVendorProducts, ShipTurtleAuthError } from "./shipturtle.js";
import { getSettings } from "../routes/settings.js";
import type { ProductRecord, VendorRecord } from "../types.js";

const RANK: Record<string, number> = { UNMAPPED: 0, PARTIALLY_MAPPED: 1, FULLY_MAPPED: 2 };

function isRegression(prev: string | undefined, next: string): boolean {
  if (!prev) return false;
  const p = RANK[prev] ?? 0;
  const n = RANK[next] ?? 0;
  return n < p;
}

export interface DriftResult {
  vendorShopId: number;
  vendorTitle: string;
  productsChecked: number;
  regressions: number;
  recoveries: number;
}

/**
 * For each vendor that we've enabled, re-fetch ShipTurtle and compare each
 * product's current mapping status to what we have stored. Flag regressions
 * (status got worse) and clear regressions for products that recovered.
 */
export async function runDriftCheckForVendor(vendor: VendorRecord): Promise<DriftResult> {
  const s = await getSettings();
  if (!s.shipturtleToken) throw new Error("shipturtle token missing");
  if (!vendor.domain) throw new Error("vendor has no domain");

  const upstream = await listAllVendorProducts(s.shipturtleToken, vendor.domain);
  const upstreamById = new Map<number, any>();
  for (const u of upstream) upstreamById.set(Number(u.id), u);

  const stored = await Collections.products.where("vendorShopId", "==", vendor.vendorShopId).get();

  let checked = 0;
  let regressions = 0;
  let recoveries = 0;

  for (const doc of stored.docs) {
    const p = doc.data() as ProductRecord;
    // Only audit products that have been pushed at least once.
    if (!p.step1?.completedAt) continue;
    const live = upstreamById.get(p.alienProductId);
    checked += 1;
    const next = live ? deriveMappingStatus(live) : "UNMAPPED";
    const prev = p.mappingStatus;

    const patch: any = { mappingStatus: next, updatedAt: Date.now() };

    if (isRegression(prev, next)) {
      patch.regressedAt = Date.now();
      patch.regressionFrom = prev;
      patch.regressionTo = next;
      regressions += 1;
      await log({
        level: "error",
        message: `Regression detected: "${p.title}" went ${prev} → ${next}`,
        vendorId: vendor.id,
        vendorName: vendor.title,
        productId: String(p.alienProductId),
        productTitle: p.title,
        step: "system",
        meta: { drift: true, from: prev, to: next, alienProductId: p.alienProductId },
      });
    } else if ((p as any).regressedAt && next === "FULLY_MAPPED") {
      // Recovery — clear the regression flag.
      patch.regressedAt = null;
      patch.regressionFrom = null;
      patch.regressionTo = null;
      recoveries += 1;
      await log({
        level: "success",
        message: `Recovery: "${p.title}" is now FULLY_MAPPED again`,
        vendorId: vendor.id,
        vendorName: vendor.title,
        productId: String(p.alienProductId),
        productTitle: p.title,
        step: "system",
        meta: { drift: true, recovered: true },
      });
    }

    await doc.ref.set(patch, { merge: true });
  }

  return { vendorShopId: vendor.vendorShopId, vendorTitle: vendor.title, productsChecked: checked, regressions, recoveries };
}

export async function runDriftCheckAllEnabledVendors() {
  const snap = await Collections.vendors.where("syncEnabled", "==", true).get();
  const vendors = snap.docs
    .map((d) => d.data() as VendorRecord)
    .filter((v) => v.brandId && v.vendorType === "Using vendor sync");
  const results: DriftResult[] = [];
  for (const v of vendors) {
    try {
      results.push(await runDriftCheckForVendor(v));
    } catch (e: any) {
      if (e instanceof ShipTurtleAuthError) {
        await log({ level: "error", message: "Drift check halted — ShipTurtle auth invalid", step: "system" });
        throw e;
      }
      await log({
        level: "warn",
        message: `Drift check failed for ${v.title}: ${e.message}`,
        vendorId: v.id,
        vendorName: v.title,
        step: "system",
      });
    }
  }
  const totals = results.reduce(
    (a, r) => ({ checked: a.checked + r.productsChecked, reg: a.reg + r.regressions, rec: a.rec + r.recoveries }),
    { checked: 0, reg: 0, rec: 0 },
  );
  await log({
    level: totals.reg > 0 ? "warn" : "info",
    message: `Drift check complete: ${totals.checked} products checked, ${totals.reg} regression(s), ${totals.rec} recovery/recoveries across ${results.length} vendor(s)`,
    step: "system",
    meta: { drift: true, summary: true },
  });
  return { vendors: results.length, ...totals, results };
}
