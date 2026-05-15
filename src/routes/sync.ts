import { Hono } from "hono";
import { Collections } from "../firestore.js";
import { getSettings } from "./settings.js";
import { syncOneProduct, syncVendor } from "../services/pipeline.js";
import { withShipTurtleAuthRetry } from "../services/shipturtle-auth.js";
import type { ProductRecord, SyncJobRecord, VendorRecord } from "../types.js";
import { log } from "../lib/log.js";

export const syncRouter = new Hono();

interface CurrentJob {
  id: string;
  startedAt: number;
  trigger: SyncJobRecord["trigger"];
  vendorShopId?: number | null;
  alienProductId?: number | null;
  status: "running" | "done" | "error";
  total: number;
  processed: number;
  succeeded: number;
  failed: number;
  currentBrandName?: string | null;
  currentVendorName?: string | null;
  currentProductTitle?: string | null;
  // Step granularity for the per-product progress bar on the Progress page.
  // Pipeline reports one of: step1, step2, step3a, step3b, step3c, done.
  // currentStepProgress is 0-100 and refreshes within Step 3c as images upload.
  currentStep?: string | null;
  currentStepProgress?: number | null;
  error?: string | null;
}

interface QueuedProduct {
  vendorId: string;
  vendorShopId: number;
  alienProductId: number;
  vendorName?: string | null;
  brandName?: string | null;
  productTitle?: string | null;
  enqueuedAt: number;
}

let currentJob: CurrentJob | null = null;
const productQueue: QueuedProduct[] = [];
// Hard cap so an over-eager click loop can't blow past the 1 GB Cloud Run RAM budget.
// At ~200 bytes per entry, 200 items is ~40 KB — generous and well below any leak threshold.
const MAX_QUEUE = 200;
let draining = false;

export function getCurrentJob(): CurrentJob | null {
  return currentJob;
}

export function getQueueSnapshot() {
  return productQueue.map((q) => ({ ...q }));
}

function isProductActive(vendorShopId: number, alienProductId: number): boolean {
  if (
    currentJob &&
    currentJob.status === "running" &&
    currentJob.vendorShopId === vendorShopId &&
    currentJob.alienProductId === alienProductId
  ) return true;
  return productQueue.some((q) => q.vendorShopId === vendorShopId && q.alienProductId === alienProductId);
}

async function startJob(j: CurrentJob) {
  currentJob = j;
  await Collections.syncJobs.doc(j.id).set(j as any);
}

async function endJob(status: "done" | "error", err?: string) {
  if (!currentJob) return;
  currentJob.status = status;
  if (err) currentJob.error = err;
  await Collections.syncJobs
    .doc(currentJob.id)
    .set({ ...(currentJob as any), finishedAt: Date.now() }, { merge: true });
  // keep reference accessible for one minute then clear — but only if nothing
  // newer (drained from the queue) has overwritten currentJob in the meantime.
  const finished = currentJob;
  setTimeout(() => {
    if (currentJob && currentJob.id === finished.id) currentJob = null;
  }, 60_000);
  // Kick the drainer — drainProductQueue ignores the 60 s grace window and
  // overwrites currentJob with the next queued product right away.
  drainProductQueue().catch((e) =>
    log({ level: "error", message: `Queue drainer crashed: ${e.message}`, step: "system" }).catch(() => {}),
  );
}

async function bumpJob(patch: Partial<CurrentJob>) {
  if (!currentJob) return;
  Object.assign(currentJob, patch);
  await Collections.syncJobs.doc(currentJob.id).set(currentJob as any, { merge: true });
}

/** Run a single product through the pipeline, owning the currentJob slot for its lifetime. */
async function runProductJob(vendor: VendorRecord, alienProductId: number, trigger: SyncJobRecord["trigger"]) {
  const jobId = `job_${Date.now()}_${alienProductId}`;
  const productSnap = await Collections.products.doc(`${vendor.vendorShopId}_${alienProductId}`).get();
  const hint = productSnap.exists ? (productSnap.data() as ProductRecord).raw : undefined;
  await startJob({
    id: jobId,
    startedAt: Date.now(),
    trigger,
    vendorShopId: vendor.vendorShopId,
    alienProductId,
    status: "running",
    total: 1,
    processed: 0,
    succeeded: 0,
    failed: 0,
    currentVendorName: vendor.title,
    currentBrandName: vendor.brandName ?? null,
    currentProductTitle: (hint as any)?.title ?? null,
  });
  try {
    const r = await withShipTurtleAuthRetry(getSettings, () =>
      syncOneProduct(
        vendor,
        alienProductId,
        hint,
        async (info) => {
          // Pipeline asks us to re-queue this product for another attempt.
          // Push to the front so retries don't get starved by newer manual maps.
          await enqueueProductForRetry(info.vendorId, info.alienProductId);
        },
        async (s) => {
          // Step + percent surface to the Progress page via /api/sync/status.
          await bumpJob({ currentStep: s.step, currentStepProgress: s.progress ?? 0 });
        },
      ),
    );
    await bumpJob({
      processed: 1,
      succeeded: r.ok ? 1 : 0,
      failed: r.ok ? 0 : 1,
    });
    await endJob(r.ok ? "done" : "error", r.ok ? undefined : r.reason);
  } catch (e: any) {
    await log({ level: "error", message: `Product sync failed: ${e.message}`, vendorId: vendor.id });
    await endJob("error", e.message);
  }
}

/**
 * Re-queue a product that the pipeline rolled back and asked to retry. We push
 * to the FRONT so the retry runs ahead of newer manual map clicks — keeping a
 * single product's lifecycle contiguous in the log and freeing the slot
 * predictably. retryCount is bumped by the pipeline before this fires.
 */
async function enqueueProductForRetry(vendorId: string, alienProductId: number) {
  const snap = await Collections.vendors.doc(vendorId).get();
  if (!snap.exists) return;
  const vendor = snap.data() as VendorRecord;
  let productTitle: string | null = null;
  try {
    const ps = await Collections.products.doc(`${vendor.vendorShopId}_${alienProductId}`).get();
    if (ps.exists) productTitle = (ps.data() as ProductRecord)?.title ?? null;
  } catch {}
  productQueue.unshift({
    vendorId: vendor.id,
    vendorShopId: vendor.vendorShopId,
    alienProductId,
    vendorName: vendor.title,
    brandName: vendor.brandName ?? null,
    productTitle,
    enqueuedAt: Date.now(),
  });
}

/**
 * Drain queued single-product map requests one at a time. The pipeline is
 * single-threaded by design (1 GB Cloud Run, image work via Sharp, ShipTurtle
 * rate limits) so we explicitly serialize.
 */
async function drainProductQueue() {
  if (draining) return;
  draining = true;
  try {
    while (productQueue.length > 0) {
      // Wait until any currently-running job finishes. endJob() schedules a
      // drainer call after setting status, but a vendor-sync that started
      // independently might still be running — yield until clear.
      if (currentJob && currentJob.status === "running") return;
      const next = productQueue.shift();
      if (!next) break;
      const snap = await Collections.vendors.doc(next.vendorId).get();
      if (!snap.exists) {
        await log({
          level: "warn",
          message: `Queued product dropped: vendor ${next.vendorId} no longer exists`,
          step: "system",
        }).catch(() => {});
        continue;
      }
      const vendor = snap.data() as VendorRecord;
      if (!vendor.brandId) {
        await log({
          level: "warn",
          message: `Queued product dropped: vendor ${vendor.title} has no brand mapping`,
          vendorId: vendor.id,
          step: "system",
        }).catch(() => {});
        continue;
      }
      // runProductJob owns currentJob; awaiting it serializes the loop.
      await runProductJob(vendor, next.alienProductId, "manual_product");
    }
  } finally {
    draining = false;
  }
}

syncRouter.get("/status", async (c) => {
  return c.json({
    current: currentJob,
    queue: getQueueSnapshot(),
    queueDepth: productQueue.length,
  });
});

syncRouter.get("/jobs", async (c) => {
  const snap = await Collections.syncJobs.orderBy("startedAt", "desc").limit(50).get();
  return c.json(snap.docs.map((d) => d.data()));
});

syncRouter.post("/vendor/:id", async (c) => {
  // Vendor & run-all jobs are bulk operations — block them whenever any
  // single-product work is in flight, queued, or being handed off between
  // queue items (the `draining` flag covers that gap).
  if (currentJob && currentJob.status === "running")
    return c.json({ error: "another_job_running", job: currentJob, queueDepth: productQueue.length }, 409);
  if (productQueue.length > 0 || draining)
    return c.json({ error: "queue_not_empty", queueDepth: productQueue.length }, 409);
  const id = c.req.param("id");
  const snap = await Collections.vendors.doc(id).get();
  if (!snap.exists) return c.json({ error: "vendor_not_found" }, 404);
  const vendor = snap.data() as VendorRecord;
  if (!vendor.brandId) return c.json({ error: "no_brand_mapping" }, 400);
  const jobId = `job_${Date.now()}`;
  await startJob({
    id: jobId,
    startedAt: Date.now(),
    trigger: "manual_vendor",
    vendorShopId: vendor.vendorShopId,
    status: "running",
    total: 0,
    processed: 0,
    succeeded: 0,
    failed: 0,
    currentVendorName: vendor.title,
    currentBrandName: vendor.brandName ?? null,
  });
  // Run async; respond immediately.
  (async () => {
    try {
      const r = await withShipTurtleAuthRetry(getSettings, () =>
        syncVendor(vendor, {
          onProgress: async (p) => {
            await bumpJob({ total: p.total, processed: p.processed, currentProductTitle: p.currentTitle });
          },
          onRetryRequested: async (info) => {
            await enqueueProductForRetry(info.vendorId, info.alienProductId);
          },
          onStep: async (s) => {
            await bumpJob({ currentStep: s.step, currentStepProgress: s.progress ?? 0 });
          },
        }),
      );
      await bumpJob({
        total: r.total,
        processed: r.total,
        succeeded: r.succeeded,
        failed: r.failed,
        currentProductTitle: null,
      });
      await endJob("done");
    } catch (e: any) {
      await log({ level: "error", message: `Vendor sync failed: ${e.message}`, vendorId: vendor.id });
      await endJob("error", e.message);
    }
  })();
  return c.json({ jobId });
});

syncRouter.post("/product/:vendorId/:alienProductId", async (c) => {
  const vendorId = c.req.param("vendorId");
  const alienProductId = Number(c.req.param("alienProductId"));
  if (!Number.isFinite(alienProductId)) return c.json({ error: "invalid_alien_product_id" }, 400);
  const snap = await Collections.vendors.doc(vendorId).get();
  if (!snap.exists) return c.json({ error: "vendor_not_found" }, 404);
  const vendor = snap.data() as VendorRecord;
  if (!vendor.brandId) return c.json({ error: "no_brand_mapping" }, 400);

  // Dedup: if this exact product is already running or queued, hand back the
  // existing slot rather than starting a second pass on the same record.
  if (isProductActive(vendor.vendorShopId, alienProductId)) {
    const pos = productQueue.findIndex(
      (q) => q.vendorShopId === vendor.vendorShopId && q.alienProductId === alienProductId,
    );
    return c.json({
      queued: pos >= 0,
      running: pos < 0,
      position: pos >= 0 ? pos + 1 : 0,
      queueDepth: productQueue.length,
      duplicate: true,
    });
  }

  if (productQueue.length >= MAX_QUEUE) {
    return c.json({ error: "queue_full", queueDepth: productQueue.length, max: MAX_QUEUE }, 503);
  }

  // All single-product requests funnel through the queue. Even when nothing
  // is in flight, we push and let drainProductQueue start the work — this
  // avoids a race where two requests both observe "no currentJob" before
  // either has had a chance to flip it (runProductJob awaits Firestore
  // before startJob runs, so the flag isn't synchronously set).
  let productTitle: string | null = null;
  try {
    const ps = await Collections.products.doc(`${vendor.vendorShopId}_${alienProductId}`).get();
    if (ps.exists) productTitle = (ps.data() as ProductRecord)?.title ?? null;
  } catch {}
  productQueue.push({
    vendorId: vendor.id,
    vendorShopId: vendor.vendorShopId,
    alienProductId,
    vendorName: vendor.title,
    brandName: vendor.brandName ?? null,
    productTitle,
    enqueuedAt: Date.now(),
  });
  const position = productQueue.length;
  drainProductQueue().catch((e) =>
    log({ level: "error", message: `Queue drainer crashed: ${e.message}`, step: "system" }).catch(() => {}),
  );
  return c.json({
    queued: true,
    position,
    queueDepth: productQueue.length,
  });
});

syncRouter.post("/run-all", async (c) => {
  if (currentJob && currentJob.status === "running")
    return c.json({ error: "another_job_running", job: currentJob, queueDepth: productQueue.length }, 409);
  if (productQueue.length > 0 || draining)
    return c.json({ error: "queue_not_empty", queueDepth: productQueue.length }, 409);
  const settings = await getSettings();
  if (!settings.globalSyncEnabled) return c.json({ error: "global_sync_off" }, 400);
  const snap = await Collections.vendors.where("syncEnabled", "==", true).get();
  const vendors = snap.docs
    .map((d) => d.data() as VendorRecord)
    .filter((v) => v.brandId && v.vendorType === "Using vendor sync");
  if (vendors.length === 0) return c.json({ error: "no_enabled_vendors" }, 400);
  const jobId = `job_${Date.now()}`;
  await startJob({
    id: jobId,
    startedAt: Date.now(),
    trigger: "cron",
    status: "running",
    total: 0,
    processed: 0,
    succeeded: 0,
    failed: 0,
  });
  (async () => {
    let total = 0, processed = 0, succeeded = 0, failed = 0;
    try {
      for (const vendor of vendors) {
        await bumpJob({ currentVendorName: vendor.title, currentBrandName: vendor.brandName ?? null });
        const r = await withShipTurtleAuthRetry(getSettings, () =>
          syncVendor(vendor, {
            onProgress: async (p) => {
              await bumpJob({
                total: total + p.total,
                processed: processed + p.processed,
                currentProductTitle: p.currentTitle,
              });
            },
            onRetryRequested: async (info) => {
              await enqueueProductForRetry(info.vendorId, info.alienProductId);
            },
            onStep: async (s) => {
              await bumpJob({ currentStep: s.step, currentStepProgress: s.progress ?? 0 });
            },
          }),
        );
        total += r.total; processed += r.total; succeeded += r.succeeded; failed += r.failed;
      }
      await bumpJob({ total, processed, succeeded, failed, currentProductTitle: null });
      await endJob("done");
    } catch (e: any) {
      await log({ level: "error", message: `Run-all failed: ${e.message}` });
      await endJob("error", e.message);
    }
  })();
  return c.json({ jobId, vendors: vendors.length });
});
