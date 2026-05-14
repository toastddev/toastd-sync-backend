import { Hono } from "hono";
import { z } from "zod";
import { Collections } from "../firestore.js";
import { getSettings } from "./settings.js";
import {
  findVendorByDocId,
  listApprovedVendors,
  listAllVendorProducts,
  searchApprovedVendors,
  searchVendorProducts,
  vendorShopMappedCount,
  checkVendorShopStatus,
  deriveMappingStatus,
  ShipTurtleAuthError,
} from "../services/shipturtle.js";
import type { VendorRecord } from "../types.js";
import { log } from "../lib/log.js";

export const vendorsRouter = new Hono();

/** Map a ShipTurtle vendor (live row) to the dashboard's VendorRecord shape. */
function mapLiveVendor(v: any, prev?: Partial<VendorRecord>): VendorRecord {
  const docId = String(v.vendor_shop?.id ?? v.vendor_shop_id ?? v.id);
  const vendorShopId = Number(v.vendor_shop?.id ?? v.vendor_shop_id ?? 0);
  return {
    id: docId,
    vendorShopId: Number.isFinite(vendorShopId) ? vendorShopId : 0,
    parentVendorId: v.parent_id ?? prev?.parentVendorId ?? null,
    title: v.title ?? v.company_name ?? prev?.title ?? "(unnamed)",
    companyName: v.company_name ?? prev?.companyName ?? null,
    email: v.email ?? prev?.email ?? null,
    domain: v.vendor_shop?.domain ?? prev?.domain ?? null,
    vendorType: v.vendor_summary?.vendor_type ?? prev?.vendorType ?? null,
    syncEnabled: prev?.syncEnabled ?? false,
    brandId: prev?.brandId ?? null,
    brandName: prev?.brandName ?? null,
    lastSyncAt: prev?.lastSyncAt ?? null,
    lastSyncStatus: prev?.lastSyncStatus ?? null,
    lastError: prev?.lastError ?? null,
    totalProducts: v.vendor_summary?.products ?? prev?.totalProducts ?? 0,
    mappedProducts: prev?.mappedProducts ?? 0,
    isFrozen: prev?.isFrozen ?? false,
    raw: v,
    updatedAt: Date.now(),
  };
}

/**
 * Read a vendor from Firestore. If the doc is missing or incomplete (no title /
 * no domain), do a live ShipTurtle lookup and persist the merged record. Returns
 * `null` if the vendor cannot be resolved at all.
 */
async function ensureVendorFresh(docId: string, token: string): Promise<VendorRecord | null> {
  const ref = Collections.vendors.doc(docId);
  const snap = await ref.get();
  const stored = snap.exists ? (snap.data() as Partial<VendorRecord>) : null;

  const isComplete = !!(stored && stored.title && stored.title !== "(unnamed)" && stored.domain);
  if (isComplete) return stored as VendorRecord;

  // Heal — live lookup using whatever hints we already have.
  const live = await findVendorByDocId(token, docId, {
    name: stored?.title ?? null,
    vendorShopId: stored?.vendorShopId ?? null,
    parentVendorId: stored?.parentVendorId ?? null,
  });
  if (!live) {
    return stored ? (stored as VendorRecord) : null;
  }
  const merged = mapLiveVendor(live, stored ?? {});
  await ref.set(merged, { merge: true });
  return merged;
}

vendorsRouter.get("/", async (c) => {
  // No orderBy — Firestore would silently drop docs missing the order field.
  const snap = await Collections.vendors.get();
  const vendors = snap.docs.map((d) => d.data() as VendorRecord);
  vendors.sort((a, b) => (a.title ?? "").localeCompare(b.title ?? ""));
  return c.json(vendors);
});

const VendorSearchBody = z.object({
  search: z.string().optional(),
  start: z.number().int().min(0).optional(),
  length: z.number().int().min(1).max(200).optional(),
});

/**
 * Live ShipTurtle vendor search with pagination. Merges Firestore-stored
 * `syncEnabled`, `brandId`, `brandName` so the dashboard sees a complete row.
 */
vendorsRouter.post("/search", async (c) => {
  const s = await getSettings();
  if (!s.shipturtleToken) return c.json({ error: "ShipTurtle token not set" }, 400);
  const body = await c.req.json().catch(() => ({}));
  const p = VendorSearchBody.safeParse(body);
  if (!p.success) return c.json({ error: p.error.flatten() }, 400);
  try {
    const r = await searchApprovedVendors(s.shipturtleToken, {
      search: p.data.search,
      start: p.data.start ?? 0,
      length: p.data.length ?? 50,
    });
    const ids = r.data.map((v: any) => String(v.vendor_shop?.id ?? v.vendor_shop_id ?? v.id));
    const reads = await Promise.all(
      ids.map((id) => (id && id !== "undefined" ? Collections.vendors.doc(id).get() : null)),
    );
    const merged = r.data.map((v: any, i: number) => {
      const stored = reads[i]?.data() as VendorRecord | undefined;
      const id = ids[i];
      return {
        id,
        vendorShopId: Number(v.vendor_shop?.id ?? v.vendor_shop_id ?? 0),
        title: v.title ?? v.company_name ?? "(unnamed)",
        companyName: v.company_name ?? null,
        email: v.email ?? null,
        domain: v.vendor_shop?.domain ?? null,
        vendorType: v.vendor_summary?.vendor_type ?? null,
        totalProducts: v.vendor_summary?.products ?? 0,
        syncEnabled: stored?.syncEnabled ?? false,
        brandId: stored?.brandId ?? null,
        brandName: stored?.brandName ?? null,
        lastSyncAt: stored?.lastSyncAt ?? null,
        lastSyncStatus: stored?.lastSyncStatus ?? null,
        mappedProducts: stored?.mappedProducts ?? 0,
        isFrozen: stored?.isFrozen ?? false,
      };
    });
    return c.json({
      data: merged,
      recordsTotal: r.recordsTotal,
      recordsFiltered: r.recordsFiltered,
    });
  } catch (e: any) {
    if (e instanceof ShipTurtleAuthError) return c.json({ error: "shipturtle_auth", message: e.message }, 401);
    return c.json({ error: e.message }, 500);
  }
});

vendorsRouter.post("/refresh", async (c) => {
  const s = await getSettings();
  if (!s.shipturtleToken) return c.json({ error: "ShipTurtle token not set" }, 400);
  try {
    const list = await listApprovedVendors(s.shipturtleToken);
    const batch = Collections.vendors.firestore.batch();
    for (const v of list) {
      const docId = String(v.vendor_shop?.id ?? v.vendor_shop_id ?? v.id);
      if (!docId || docId === "undefined") continue;
      const ref = Collections.vendors.doc(docId);
      const existing = (await ref.get()).data() as Partial<VendorRecord> | undefined;
      batch.set(ref, mapLiveVendor(v, existing), { merge: true });
    }
    await batch.commit();
    await log({ level: "success", message: `Refreshed ${list.length} vendors from ShipTurtle`, step: "system" });
    return c.json({ count: list.length });
  } catch (e: any) {
    if (e instanceof ShipTurtleAuthError) {
      await log({ level: "error", message: "ShipTurtle auth invalid — update token in Settings", step: "system" });
      return c.json({ error: "shipturtle_auth", message: e.message }, 401);
    }
    await log({ level: "error", message: `Vendor refresh failed: ${e.message}`, step: "system" });
    return c.json({ error: e.message }, 500);
  }
});

const PatchBody = z.object({
  syncEnabled: z.boolean().optional(),
  brandId: z.string().nullable().optional(),
  brandName: z.string().nullable().optional(),
});

/**
 * Patch dashboard-side vendor fields. Refuses if the vendor record is unknown
 * (caller must run /refresh first), so we never create an empty Firestore doc
 * that would later mask the real ShipTurtle data.
 */
vendorsRouter.patch("/:id", async (c) => {
  const id = c.req.param("id");
  const body = await c.req.json();
  const p = PatchBody.safeParse(body);
  if (!p.success) return c.json({ error: p.error.flatten() }, 400);
  const s = await getSettings();
  let vendor: VendorRecord | null = null;
  if (s.shipturtleToken) {
    vendor = await ensureVendorFresh(id, s.shipturtleToken);
  } else {
    const snap = await Collections.vendors.doc(id).get();
    vendor = snap.exists ? (snap.data() as VendorRecord) : null;
  }
  if (!vendor) return c.json({ error: "vendor_not_found" }, 404);
  await Collections.vendors.doc(id).set({ ...p.data, updatedAt: Date.now() }, { merge: true });
  return c.json({ ok: true });
});

vendorsRouter.get("/:id", async (c) => {
  const id = c.req.param("id");
  const s = await getSettings();
  let vendor: VendorRecord | null = null;
  if (s.shipturtleToken) {
    vendor = await ensureVendorFresh(id, s.shipturtleToken);
  } else {
    const snap = await Collections.vendors.doc(id).get();
    vendor = snap.exists ? (snap.data() as VendorRecord) : null;
  }
  if (!vendor) return c.json({ error: "not_found" }, 404);
  return c.json(vendor);
});

vendorsRouter.get("/:id/products", async (c) => {
  const id = c.req.param("id");
  const snap = await Collections.products.where("vendorShopId", "==", Number(id)).get();
  const products = snap.docs.map((d) => d.data());
  return c.json(products);
});

const ProductSearchBody = z.object({
  search: z.string().optional(),
  start: z.number().int().min(0).optional(),
  length: z.number().int().min(1).max(200).optional(),
  filters: z
    .object({
      title: z.string().optional(),
      product_type: z.string().optional(),
      tags: z.string().optional(),
      status: z.string().optional(),
      quantity: z.string().optional(),
      mapping_status: z.string().optional(),
    })
    .optional(),
});

function noShopResponse(vendor: VendorRecord) {
  const isCloudType = vendor.vendorType && vendor.vendorType !== "Using vendor sync";
  return {
    data: [],
    recordsTotal: 0,
    recordsFiltered: 0,
    noShop: true,
    vendorType: vendor.vendorType ?? null,
    message: isCloudType
      ? `This vendor's type is "${vendor.vendorType}" — only "Using vendor sync" vendors expose a Shopify shop to read products from.`
      : "This vendor has no Shopify shop mapped in ShipTurtle yet.",
  };
}

/** Live ShipTurtle product search for one vendor (paginated, with column filters). */
vendorsRouter.post("/:id/products/search", async (c) => {
  const id = c.req.param("id");
  const s = await getSettings();
  if (!s.shipturtleToken) return c.json({ error: "ShipTurtle token not set" }, 400);
  const vendor = await ensureVendorFresh(id, s.shipturtleToken);
  if (!vendor) return c.json({ error: "vendor_not_found" }, 404);
  if (!vendor.domain) return c.json(noShopResponse(vendor));
  const body = await c.req.json().catch(() => ({}));
  const p = ProductSearchBody.safeParse(body);
  if (!p.success) return c.json({ error: p.error.flatten() }, 400);
  try {
    const r = await searchVendorProducts(s.shipturtleToken, vendor.domain, {
      search: p.data.search,
      start: p.data.start ?? 0,
      length: p.data.length ?? 50,
      filters: p.data.filters,
    });
    const docIds = r.data.map((u: any) => `${vendor.vendorShopId}_${u.id}`);
    const reads = await Promise.all(docIds.map((d) => Collections.products.doc(d).get()));
    const merged = r.data.map((u: any, i: number) => {
      const stored = reads[i]?.data() as any | undefined;
      return {
        id: docIds[i],
        vendorShopId: vendor.vendorShopId,
        alienProductId: Number(u.id),
        title: u.title,
        handle: u.handle ?? null,
        vendorDomain: vendor.domain,
        productType: u.product_type ?? null,
        status: u.status ?? null,
        image: u.image ?? null,
        mappingStatus: deriveMappingStatus(u),
        pipelineStatus: stored?.pipelineStatus ?? "pending",
        step1: stored?.step1 ?? null,
        step2: stored?.step2 ?? null,
        step3: stored?.step3 ?? null,
        lastError: stored?.lastError ?? null,
        regressedAt: stored?.regressedAt ?? null,
        regressionFrom: stored?.regressionFrom ?? null,
        regressionTo: stored?.regressionTo ?? null,
      };
    });
    return c.json({
      data: merged,
      recordsTotal: r.recordsTotal,
      recordsFiltered: r.recordsFiltered,
    });
  } catch (e: any) {
    if (e instanceof ShipTurtleAuthError) return c.json({ error: "shipturtle_auth", message: e.message }, 401);
    return c.json({ error: e.message }, 500);
  }
});

vendorsRouter.post("/:id/products/refresh", async (c) => {
  const id = c.req.param("id");
  const s = await getSettings();
  if (!s.shipturtleToken) return c.json({ error: "ShipTurtle token not set" }, 400);
  const vendor = await ensureVendorFresh(id, s.shipturtleToken);
  if (!vendor) return c.json({ error: "vendor_not_found" }, 404);
  if (!vendor.domain) return c.json({ count: 0, noShop: true });
  try {
    const products = await listAllVendorProducts(s.shipturtleToken, vendor.domain);
    let status: { mapped_products: number; total_products: number } | null = null;
    try {
      status = await vendorShopMappedCount(s.shipturtleToken, vendor.vendorShopId);
    } catch {}
    let frozen: { is_frozen: boolean } | null = null;
    try {
      frozen = await checkVendorShopStatus(s.shipturtleToken, vendor.vendorShopId);
    } catch {}
    const batch = Collections.products.firestore.batch();
    for (const p of products) {
      const docId = `${vendor.vendorShopId}_${p.id}`;
      const ref = Collections.products.doc(docId);
      const existing = (await ref.get()).data();
      batch.set(
        ref,
        {
          id: docId,
          vendorShopId: vendor.vendorShopId,
          alienProductId: Number(p.id),
          title: p.title,
          handle: p.handle ?? null,
          vendorDomain: vendor.domain,
          productType: p.product_type ?? null,
          status: p.status ?? null,
          image: p.image ?? null,
          mappingStatus: deriveMappingStatus(p),
          pipelineStatus: existing?.pipelineStatus ?? "pending",
          step1: existing?.step1 ?? null,
          step2: existing?.step2 ?? null,
          step3: existing?.step3 ?? null,
          lastError: existing?.lastError ?? null,
          raw: p,
          updatedAt: Date.now(),
        },
        { merge: true },
      );
    }
    await batch.commit();
    await Collections.vendors.doc(id).set(
      {
        totalProducts: status?.total_products ?? products.length,
        mappedProducts: status?.mapped_products ?? 0,
        isFrozen: frozen?.is_frozen ?? false,
        updatedAt: Date.now(),
      },
      { merge: true },
    );
    return c.json({ count: products.length });
  } catch (e: any) {
    if (e instanceof ShipTurtleAuthError) return c.json({ error: "shipturtle_auth" }, 401);
    return c.json({ error: e.message }, 500);
  }
});
