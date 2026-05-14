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
  error?: string | null;
}

let currentJob: CurrentJob | null = null;

export function getCurrentJob(): CurrentJob | null {
  return currentJob;
}

async function startJob(j: CurrentJob) {
  currentJob = j;
  await Collections.syncJobs.doc(j.id).set(j as any);
}

async function endJob(status: "done" | "error", err?: string) {
  if (!currentJob) return;
  currentJob.status = status;
  if (err) currentJob.error = err;
  await Collections.syncJobs.doc(currentJob.id).set({ ...(currentJob as any), finishedAt: Date.now() }, { merge: true });
  // keep reference accessible for one minute then clear
  const finished = currentJob;
  setTimeout(() => {
    if (currentJob && currentJob.id === finished.id) currentJob = null;
  }, 60_000);
}

async function bumpJob(patch: Partial<CurrentJob>) {
  if (!currentJob) return;
  Object.assign(currentJob, patch);
  await Collections.syncJobs.doc(currentJob.id).set(currentJob as any, { merge: true });
}

syncRouter.get("/status", async (c) => {
  return c.json({ current: currentJob });
});

syncRouter.get("/jobs", async (c) => {
  const snap = await Collections.syncJobs.orderBy("startedAt", "desc").limit(50).get();
  return c.json(snap.docs.map((d) => d.data()));
});

syncRouter.post("/vendor/:id", async (c) => {
  if (currentJob && currentJob.status === "running") return c.json({ error: "another_job_running", job: currentJob }, 409);
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
  if (currentJob && currentJob.status === "running") return c.json({ error: "another_job_running", job: currentJob }, 409);
  const vendorId = c.req.param("vendorId");
  const alienProductId = Number(c.req.param("alienProductId"));
  const snap = await Collections.vendors.doc(vendorId).get();
  if (!snap.exists) return c.json({ error: "vendor_not_found" }, 404);
  const vendor = snap.data() as VendorRecord;
  if (!vendor.brandId) return c.json({ error: "no_brand_mapping" }, 400);
  const jobId = `job_${Date.now()}`;
  await startJob({
    id: jobId,
    startedAt: Date.now(),
    trigger: "manual_product",
    vendorShopId: vendor.vendorShopId,
    alienProductId,
    status: "running",
    total: 1,
    processed: 0,
    succeeded: 0,
    failed: 0,
    currentVendorName: vendor.title,
    currentBrandName: vendor.brandName ?? null,
  });
  (async () => {
    try {
      const productSnap = await Collections.products.doc(`${vendor.vendorShopId}_${alienProductId}`).get();
      const hint = productSnap.exists ? (productSnap.data() as ProductRecord).raw : undefined;
      await bumpJob({ currentProductTitle: (hint as any)?.title ?? null });
      const r = await withShipTurtleAuthRetry(getSettings, () => syncOneProduct(vendor, alienProductId, hint));
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
  })();
  return c.json({ jobId });
});

syncRouter.post("/run-all", async (c) => {
  if (currentJob && currentJob.status === "running") return c.json({ error: "another_job_running", job: currentJob }, 409);
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
