import { Hono } from "hono";
import { Collections } from "../firestore.js";
import { runDriftCheckAllEnabledVendors, runDriftCheckForVendor } from "../services/drift.js";
import type { ProductRecord, VendorRecord } from "../types.js";

export const productsRouter = new Hono();

/** Products that have regressed (mapped → unmapped) since last drift check. */
productsRouter.get("/regressions", async (c) => {
  // range query on a single field — no composite index required
  const snap = await Collections.products.where("regressedAt", ">", 0).orderBy("regressedAt", "desc").limit(500).get();
  return c.json(snap.docs.map((d) => d.data()));
});

/** Trigger a drift check on demand (all enabled vendors, or one vendor by id). */
productsRouter.post("/drift-check", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { vendorId?: string };
  if (body.vendorId) {
    const vsnap = await Collections.vendors.doc(body.vendorId).get();
    if (!vsnap.exists) return c.json({ error: "vendor_not_found" }, 404);
    const r = await runDriftCheckForVendor(vsnap.data() as VendorRecord);
    return c.json(r);
  }
  const r = await runDriftCheckAllEnabledVendors();
  return c.json(r);
});
