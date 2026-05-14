import { Collections } from "../firestore.js";
import { log } from "../lib/log.js";
import { getSettings } from "../routes/settings.js";
import { deleteShopifyProduct, type ShopifyCreds } from "./shopify.js";
import { deleteToastdProduct, listProductFiles } from "./toastd.js";
import type { ProductRecord } from "../types.js";

/**
 * Scan for products left in `pipelineStatus === "running"` from a previous
 * process crash, delete any partial Shopify/Toastd resources they created,
 * and reset them to `pending` so the next sync run starts cleanly from step 1.
 *
 * Safe to call on every startup — products with all 3 steps complete are
 * already marked `done`, and products that crashed AFTER images uploaded are
 * preserved (we won't delete user-visible Toastd data).
 */
export async function recoverInFlightProducts(): Promise<void> {
  const snap = await Collections.products.where("pipelineStatus", "==", "running").get();
  if (snap.empty) {
    await log({ level: "info", message: "Recovery: no in-flight products", step: "system" }).catch(() => {});
    return;
  }

  const settings = await getSettings();
  const shopify: ShopifyCreds | null =
    settings.shopifyStoreDomain && settings.shopifyAdminToken
      ? { domain: settings.shopifyStoreDomain, adminToken: settings.shopifyAdminToken }
      : null;

  let rolledBack = 0;
  let preserved = 0;
  let failed = 0;

  for (const doc of snap.docs) {
    const p = doc.data() as ProductRecord;
    const shopifyGid = p.step1?.shopifyProductGid;
    const toastdId = p.step3?.toastdProductId;

    // If a Toastd record exists and already has images attached, preserve it —
    // the product is load-bearing for downstream consumers; matches the
    // canRollback() heuristic the in-process catch uses.
    let toastdSafe = true;
    if (toastdId && settings.toastdAdminToken) {
      try {
        const files = await listProductFiles(toastdId, settings.toastdAdminToken);
        if (files.length > 0) toastdSafe = false;
      } catch {
        // Can't tell — err on the side of preserving.
        toastdSafe = false;
      }
    }

    if (!toastdSafe) {
      await log({
        level: "warn",
        message: `Recovery: preserving partial product (already has Toastd images)`,
        vendorId: String(p.vendorShopId ?? ""),
        productId: String(p.alienProductId ?? ""),
        productTitle: p.title,
        step: "system",
      }).catch(() => {});
      await doc.ref
        .set({ pipelineStatus: "error", lastError: "interrupted mid-images — needs manual review", updatedAt: Date.now() }, { merge: true })
        .catch(() => {});
      preserved += 1;
      continue;
    }

    try {
      if (shopifyGid && shopify) {
        try {
          await deleteShopifyProduct(shopify, shopifyGid);
        } catch (e: any) {
          await log({
            level: "warn",
            message: `Recovery: Shopify delete failed (continuing): ${e.message}`,
            productId: String(p.alienProductId ?? ""),
            productTitle: p.title,
            step: "system",
          }).catch(() => {});
        }
      }
      if (toastdId && settings.toastdAdminToken) {
        try {
          await deleteToastdProduct(toastdId, settings.toastdAdminToken);
        } catch (e: any) {
          await log({
            level: "warn",
            message: `Recovery: Toastd delete failed (continuing): ${e.message}`,
            productId: String(p.alienProductId ?? ""),
            productTitle: p.title,
            step: "system",
          }).catch(() => {});
        }
      }

      // Clear all step state so the next syncOneProduct() starts from step 1.
      await doc.ref.set(
        {
          pipelineStatus: "pending",
          step1: null,
          step2: null,
          step3: null,
          lastError: "recovered after restart — will re-run from step 1",
          updatedAt: Date.now(),
        },
        { merge: true },
      );
      rolledBack += 1;

      await log({
        level: "warn",
        message: `Recovery: rolled back interrupted product, will re-run on next sync`,
        vendorId: String(p.vendorShopId ?? ""),
        productId: String(p.alienProductId ?? ""),
        productTitle: p.title,
        step: "system",
        meta: { shopifyGid, toastdId },
      }).catch(() => {});
    } catch (e: any) {
      failed += 1;
      await log({
        level: "error",
        message: `Recovery: failed to roll back product: ${e.message}`,
        productId: String(p.alienProductId ?? ""),
        productTitle: p.title,
        step: "system",
      }).catch(() => {});
    }
  }

  // Same idea at the job level — any running sync job from a previous crash
  // is no longer accurate. Mark them done(error) so the UI doesn't think
  // there's a live job.
  try {
    const jobs = await Collections.syncJobs.where("status", "==", "running").get();
    for (const jdoc of jobs.docs) {
      await jdoc.ref
        .set({ status: "error", error: "interrupted by restart", finishedAt: Date.now() }, { merge: true })
        .catch(() => {});
    }
  } catch {}

  await log({
    level: "info",
    message: `Recovery sweep complete: ${rolledBack} rolled back, ${preserved} preserved, ${failed} failed`,
    step: "system",
  }).catch(() => {});
}
