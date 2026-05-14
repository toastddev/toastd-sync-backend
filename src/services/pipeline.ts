import { Collections } from "../firestore.js";
import { log } from "../lib/log.js";
import {
  addVendorProduct,
  fetchVendorProducts,
  listAllVendorProducts,
  searchVendorProducts,
  ShipTurtleAuthError,
} from "./shipturtle.js";
import {
  deleteShopifyProduct,
  enableInventoryTracking,
  findRecentProductByTitle,
  findToastdPublicationIds,
  publishToPublications,
  ShopifyAuthError,
  type ShopifyCreds,
} from "./shopify.js";
import {
  aiProductCreate,
  ASSETS_BASE_URL,
  createProduct,
  deleteToastdProduct,
  downloadAndConvertWebp,
  getBrand,
  getPresignedUrl,
  listProductFiles,
  recordFile,
  uploadToGcs,
} from "./toastd.js";
import { getSettings } from "../routes/settings.js";
import type { ProductRecord, Settings, VendorRecord } from "../types.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface RunOpts {
  jobId?: string;
  onProgress?: (p: { processed: number; total: number; currentTitle?: string }) => Promise<void> | void;
}

export interface PipelineResult {
  ok: boolean;
  productDocId: string;
  reason?: string;
  shopifyProductGid?: string;
  toastdProductId?: string;
}

async function loadProduct(vendorShopId: number, alienProductId: number) {
  const id = `${vendorShopId}_${alienProductId}`;
  const ref = Collections.products.doc(id);
  const snap = await ref.get();
  return { id, ref, data: snap.exists ? (snap.data() as ProductRecord) : null };
}

async function pollMerchantProduct(
  settings: Settings,
  vendorDomain: string,
  alienProductId: number,
  titleHint?: string,
  attempts = 12,
  intervalMs = 5000,
) {
  for (let i = 0; i < attempts; i++) {
    try {
      // When we know the title, narrow the search server-side; otherwise fetch the most recent slice.
      const r = titleHint
        ? await searchVendorProducts(settings.shipturtleToken, vendorDomain, { filters: { title: titleHint }, length: 25 })
        : { data: await fetchVendorProducts(settings.shipturtleToken, vendorDomain, 200), recordsTotal: 0, recordsFiltered: 0, draw: 0 };
      const found = r.data.find((p: any) => Number(p.id) === alienProductId);
      if (found?.merchant_products?.length > 0) return { product: found, merchant: found.merchant_products[0] };
    } catch (e) {
      if (e instanceof ShipTurtleAuthError) throw e;
    }
    await sleep(intervalMs);
  }
  return null;
}

export async function runStep1(vendor: VendorRecord, alienProductId: number, settings: Settings, titleHint?: string) {
  if (!settings.shipturtleToken) throw new Error("ShipTurtle token not set");
  await log({
    level: "info",
    message: `Step 1: triggering ShipTurtle add-vendor-product`,
    vendorId: vendor.id,
    vendorName: vendor.title,
    productId: String(alienProductId),
    step: "step1",
  });
  await addVendorProduct(settings.shipturtleToken, alienProductId);
  const polled = await pollMerchantProduct(settings, vendor.domain!, alienProductId, titleHint);
  if (!polled) throw new Error("ShipTurtle never reported merchant product mapped (timeout)");
  await log({
    level: "success",
    message: `Step 1: ShipTurtle pushed product, merchant_product id=${polled.merchant.id}`,
    vendorId: vendor.id,
    vendorName: vendor.title,
    productId: String(alienProductId),
    productTitle: polled.product.title,
    step: "step1",
  });
  return { merchantProductId: polled.merchant.id as number, alienProduct: polled.product };
}

export async function resolveShopifyGid(
  shopify: ShopifyCreds,
  vendor: VendorRecord,
  alienProduct: any,
): Promise<string | null> {
  const title = alienProduct.title;
  const candidates = await findRecentProductByTitle(shopify, title, vendor.companyName ?? vendor.title ?? undefined);
  if (candidates.length > 0) return candidates[0].id as string;
  const fallback = await findRecentProductByTitle(shopify, title);
  if (fallback.length > 0) return fallback[0].id as string;
  return null;
}

export async function runStep2(
  shopify: ShopifyCreds,
  productGid: string,
  vendor: VendorRecord,
  productTitle: string,
  hint?: string,
) {
  await log({
    level: "info",
    message: `Step 2: resolving Online Store + Toastd publications`,
    vendorId: vendor.id,
    vendorName: vendor.title,
    productTitle,
    step: "step2",
  });
  const { onlineStore, toastdPub } = await findToastdPublicationIds(shopify, hint);
  const ids: string[] = [];
  if (onlineStore) ids.push(onlineStore.id);
  if (toastdPub) ids.push(toastdPub.id);
  if (ids.length === 0) throw new Error("Could not find Online Store or Toastd publication on this Shopify store");
  await publishToPublications(shopify, productGid, ids);
  await log({
    level: "success",
    message: `Step 2: published — onlineStore=${!!onlineStore} toastd=${!!toastdPub}`,
    vendorId: vendor.id,
    vendorName: vendor.title,
    productTitle,
    step: "step2",
  });
  return { publishedToOnlineStore: !!onlineStore, publishedToToastd: !!toastdPub };
}

function pickPrice(alienProduct: any): { amount: string; code: string; symbol: string } {
  const v = alienProduct.variants?.[0];
  const amount = v?.price ? String(v.price) : "0";
  return { amount, code: "INR", symbol: "₹" };
}

function fmtCurrency(amount: string) {
  return { amount, code: "INR", symbol: "₹" };
}

export async function runStep3(
  vendor: VendorRecord,
  alienProduct: any,
  shopifyProductGid: string,
  onProductCreated?: (toastdProductId: string) => void | Promise<void>,
  onImageUploaded?: () => void,
) {
  if (!vendor.brandId) throw new Error("vendor has no brandId mapped");
  const settings = await getSettings();
  const tdTok = settings.toastdAdminToken;
  if (!tdTok) throw new Error("Toastd admin token (x-toastd-access-token) not set in Settings");
  const brand = await getBrand(vendor.brandId, tdTok);
  const brandSlug = brand?.slug || vendor.brandName?.toLowerCase().replace(/\s+/g, "-") || vendor.brandId;
  const url = `https://${vendor.domain}/products/${alienProduct.handle}`;
  const slug = `${brandSlug}-${alienProduct.handle}`;
  const price = pickPrice(alienProduct);

  await log({
    level: "info",
    message: `Step 3a: AI product_create`,
    vendorId: vendor.id,
    vendorName: vendor.title,
    productTitle: alienProduct.title,
    step: "step3a",
    meta: { url, slug },
  });
  const ai = await aiProductCreate({ url, slug, brandId: vendor.brandId, externalId: shopifyProductGid, price }, tdTok);

  await log({
    level: "info",
    message: `Step 3b: creating product record in Toastd DB`,
    vendorId: vendor.id,
    vendorName: vendor.title,
    productTitle: alienProduct.title,
    step: "step3b",
  });
  const now = new Date().toISOString();
  const launched = now;
  const expiry = new Date(Date.now() + 2 * 365 * 24 * 60 * 60 * 1000).toISOString();
  const tagIds = (ai.tagIds as string[] | undefined) ?? [];
  const subCategoryIds = (ai.subCategoryIds as string[] | undefined) ?? [];
  const mainCategoryId = (ai.mainCategoryId as string | undefined) ?? null;

  const productPayload: any = {
    shortDescription: ai.shortDescription,
    url: ai.url ?? url,
    slug: ai.slug ?? slug,
    description: ai.description,
    headline: ai.headline,
    headlineDescription: ai.headlineDescription,
    metaTitle: ai.metaTitle,
    metaDescription: ai.metaDescription,
    metaKeywords: ai.metaKeywords,
    price: ai.price ?? price,
    brandId: vendor.brandId,
    returnPolicy: ai.returnPolicy,
    shippingDetails: ai.shippingDetails,
    isDiscounted: ai.isDiscounted ?? false,
    offer: ai.offer ?? null,
    externalProductId: shopifyProductGid,
    createdOn: now,
    launchedOn: launched,
    expiryDate: expiry,
    mainCategoryId,
    viewCount: 0,
    tapeViewCount: 0,
    upvoteCount: 0,
    tagIds,
    files: [],
    story: ai.story ?? null,
    custom: { text: "", batch: "" },
    faq: ai.faq ?? [],
    isActive: true,
    isDiscoverable: true,
    sizeChart: false,
    subCategoryIds,
  };
  const created = await createProduct(productPayload, tdTok);
  const newProductId: string = created.id;
  await onProductCreated?.(newProductId);
  await log({
    level: "success",
    message: `Step 3b: product saved id=${newProductId}`,
    vendorId: vendor.id,
    vendorName: vendor.title,
    productId: newProductId,
    productTitle: alienProduct.title,
    step: "step3b",
  });

  // Step 3c: image upload pipeline
  const rawimage: string[] = ai.rawimage ?? [];
  let imagesUploaded = 0;
  let imagesFailed = 0;
  for (let i = 0; i < rawimage.length; i++) {
    const src = rawimage[i];
    try {
      const buf = await downloadAndConvertWebp(src);
      const fileName = `${slug}_${i}_${Date.now()}.webp`;
      const objectKey = `${brandSlug}/${slug}/images/${fileName}`;
      const presigned = await getPresignedUrl(objectKey, "image/webp", tdTok);
      await uploadToGcs(presigned, buf, "image/webp");
      await recordFile({
        name: fileName,
        url: `${ASSETS_BASE_URL}/${objectKey}`,
        fileType: "image",
        productId: newProductId,
        alt: null,
        thumbnailUrl: null,
        variant: null,
      }, tdTok);
      imagesUploaded += 1;
      onImageUploaded?.();
      await log({
        level: "info",
        message: `Step 3c: uploaded ${i + 1}/${rawimage.length}`,
        vendorId: vendor.id,
        vendorName: vendor.title,
        productId: newProductId,
        productTitle: alienProduct.title,
        step: "step3c",
        meta: { fileName },
      });
    } catch (e: any) {
      imagesFailed += 1;
      await log({
        level: "warn",
        message: `Step 3c: image ${i + 1}/${rawimage.length} failed: ${e.message}`,
        vendorId: vendor.id,
        vendorName: vendor.title,
        productId: newProductId,
        productTitle: alienProduct.title,
        step: "step3c",
      });
    }
  }
  return { toastdProductId: newProductId, imagesUploaded, imagesFailed };
}

/**
 * Decide whether the partially-synced product can safely be rolled back.
 *
 * "Safe to roll back" = neither Shopify nor the Toastd DB record is yet
 * load-bearing for downstream consumers. As soon as ANY image has been saved
 * to the Toastd DB, the product is considered in-use and we leave it alone.
 */
async function canRollback(
  toastdProductId: string | undefined,
  step3ImagesUploaded: number | undefined,
  toastdToken: string,
): Promise<boolean> {
  if (!toastdProductId) return true;
  if ((step3ImagesUploaded ?? 0) > 0) return false;
  // Defensive: query Toastd in case images were attached out-of-band.
  try {
    const files = await listProductFiles(toastdProductId, toastdToken);
    return files.length === 0;
  } catch {
    // If we can't tell, err on the side of NOT deleting — preserves user data.
    return false;
  }
}

async function rollbackProduct(
  vendor: VendorRecord,
  alienProductId: number,
  productTitle: string | undefined,
  shopifyProductGid: string | undefined,
  toastdProductId: string | undefined,
  settings: Settings,
) {
  if (shopifyProductGid && settings.shopifyStoreDomain && settings.shopifyAdminToken) {
    try {
      await deleteShopifyProduct(
        { domain: settings.shopifyStoreDomain, adminToken: settings.shopifyAdminToken },
        shopifyProductGid,
      );
      await log({
        level: "warn",
        message: `Rollback: deleted Shopify product (auto-unmaps in ShipTurtle)`,
        vendorId: vendor.id,
        vendorName: vendor.title,
        productId: String(alienProductId),
        productTitle,
        step: "system",
        meta: { shopifyProductGid },
      });
    } catch (e: any) {
      await log({
        level: "error",
        message: `Rollback: Shopify product delete failed: ${e.message}`,
        vendorId: vendor.id,
        vendorName: vendor.title,
        productId: String(alienProductId),
        productTitle,
        step: "system",
      });
    }
  }
  if (toastdProductId && settings.toastdAdminToken) {
    try {
      await deleteToastdProduct(toastdProductId, settings.toastdAdminToken);
      await log({
        level: "warn",
        message: `Rollback: deleted partial Toastd product record`,
        vendorId: vendor.id,
        vendorName: vendor.title,
        productId: String(alienProductId),
        productTitle,
        step: "system",
        meta: { toastdProductId },
      });
    } catch (e: any) {
      await log({
        level: "warn",
        message: `Rollback: Toastd product delete failed (continuing): ${e.message}`,
        vendorId: vendor.id,
        vendorName: vendor.title,
        productId: String(alienProductId),
        step: "system",
      });
    }
  }
}

/** Sync a single ShipTurtle product through all 3 steps. Skips work that's already done. */
export async function syncOneProduct(
  vendor: VendorRecord,
  alienProductId: number,
  alienProductHint?: any,
): Promise<PipelineResult> {
  const settings = await getSettings();
  const productCtx = await loadProduct(vendor.vendorShopId, alienProductId);
  const ref = productCtx.ref;
  const id = productCtx.id;
  let prev = productCtx.data ?? ({} as any);

  // Rollback bookkeeping — captures resources created during THIS run so we
  // can undo them atomically on failure. Only resources we created here are
  // tracked; pre-existing state (prev.step1.shopifyProductGid from a prior
  // run, etc.) is left alone since the user/system has already had a chance
  // to consume it.
  const created = {
    shopifyProductGid: undefined as string | undefined,
    toastdProductId: undefined as string | undefined,
    step3ImagesUploaded: 0,
  };

  await ref.set({ pipelineStatus: "running", lastError: null, updatedAt: Date.now() }, { merge: true });
  try {
    let alienProduct = alienProductHint ?? prev.raw;
    let merchantProductId = prev.step1?.merchantProductId;

    // Step 1: only if not already done
    if (!prev.step1?.completedAt) {
      // We need the live alien product so we can validate status before triggering ShipTurtle.
      if (!alienProduct) {
        const list = await listAllVendorProducts(settings.shipturtleToken, vendor.domain!);
        alienProduct = list.find((p: any) => Number(p.id) === alienProductId);
        if (!alienProduct) throw new Error("Product not found in ShipTurtle");
      }
      // Hard guard — only active products are synced into the Toastd store.
      if (alienProduct.status && alienProduct.status !== "active") {
        throw new Error(
          `product status is "${alienProduct.status}" — only active products are synced (draft/archived skipped)`,
        );
      }
      const titleHint = (alienProduct?.title as string | undefined) ?? undefined;
      const r = await runStep1(vendor, alienProductId, settings, titleHint);
      merchantProductId = r.merchantProductId;
      alienProduct = r.alienProduct;
      await ref.set(
        {
          step1: { completedAt: Date.now(), merchantProductId, error: null },
          raw: alienProduct,
          updatedAt: Date.now(),
        },
        { merge: true },
      );
    }

    if (!alienProduct) {
      // Edge case: step1 was already done in a prior run but raw was lost. Fetch fully.
      const list = await listAllVendorProducts(settings.shipturtleToken, vendor.domain!);
      alienProduct = list.find((p: any) => Number(p.id) === alienProductId);
      if (!alienProduct) throw new Error("Alien product disappeared from ShipTurtle after step 1");
    }

    // Resolve Shopify GID
    let shopifyProductGid = prev.step1?.shopifyProductGid;
    if (!shopifyProductGid) {
      if (!settings.shopifyStoreDomain || !settings.shopifyAdminToken)
        throw new Error("Shopify store creds missing in Settings");
      const shopify: ShopifyCreds = { domain: settings.shopifyStoreDomain, adminToken: settings.shopifyAdminToken };
      shopifyProductGid = (await resolveShopifyGid(shopify, vendor, alienProduct)) ?? undefined;
      if (!shopifyProductGid)
        throw new Error("Could not resolve Shopify product GID by title — try again in a minute or check ShipTurtle sync");
      await ref.set({ step1: { ...(prev.step1 ?? {}), shopifyProductGid } }, { merge: true });
      // Newly created in this run — eligible for rollback if a later step fails.
      created.shopifyProductGid = shopifyProductGid;
    }

    // Inventory readiness flip (idempotent — safe to re-run on every sync).
    // Runs even when step 2 is already completed, to backfill products created
    // before this fix existed. Pushes the alien (vendor-side) quantity into
    // Shopify so the variant doesn't sit at 0 after tracking gets enabled.
    {
      const shopify: ShopifyCreds = { domain: settings.shopifyStoreDomain, adminToken: settings.shopifyAdminToken };
      try {
        const inv = await enableInventoryTracking(shopify, shopifyProductGid, alienProduct);
        if (inv.itemsUpdated > 0 || inv.variantsUpdated > 0 || inv.activated > 0 || inv.quantitiesSet > 0) {
          await log({
            level: "success",
            message: `Inventory ready: tracked=${inv.itemsUpdated}, denyOversell=${inv.variantsUpdated}, activatedAtLocation=${inv.activated}, qtysSet=${inv.quantitiesSet}`,
            vendorId: vendor.id,
            vendorName: vendor.title,
            productId: String(alienProductId),
            productTitle: alienProduct.title,
            step: "step2",
          });
        }
      } catch (e: any) {
        await log({
          level: "warn",
          message: `Inventory readiness flip failed (continuing): ${e.message}`,
          vendorId: vendor.id,
          vendorName: vendor.title,
          productId: String(alienProductId),
          productTitle: alienProduct.title,
          step: "step2",
        });
      }
    }

    // Step 2
    if (!prev.step2?.completedAt) {
      const shopify: ShopifyCreds = { domain: settings.shopifyStoreDomain, adminToken: settings.shopifyAdminToken };
      const r2 = await runStep2(shopify, shopifyProductGid, vendor, alienProduct.title, settings.toastdPublicationNameHint);
      await ref.set(
        {
          step2: { completedAt: Date.now(), publishedToOnlineStore: r2.publishedToOnlineStore, publishedToToastd: r2.publishedToToastd, error: null },
          updatedAt: Date.now(),
        },
        { merge: true },
      );
    }

    // Step 3
    let toastdProductId: string | undefined = prev.step3?.toastdProductId;
    if (!prev.step3?.completedAt) {
      const r3 = await runStep3(vendor, alienProduct, shopifyProductGid, async (id) => {
        // Capture toastdProductId as soon as the DB record is created (step 3b),
        // BEFORE images upload — so a failure mid-3c is rolled back too. We
        // also persist it eagerly so a process crash after this point is
        // still recoverable (startup sweep reads it back and rolls back).
        toastdProductId = id;
        created.toastdProductId = id;
        await ref.set(
          { step3: { ...(prev.step3 ?? {}), toastdProductId: id }, updatedAt: Date.now() },
          { merge: true },
        );
      }, () => {
        created.step3ImagesUploaded += 1;
      });
      toastdProductId = r3.toastdProductId;
      await ref.set(
        {
          step3: { completedAt: Date.now(), toastdProductId, imagesUploaded: r3.imagesUploaded, imagesFailed: r3.imagesFailed, error: null },
          pipelineStatus: "done",
          updatedAt: Date.now(),
        },
        { merge: true },
      );
    } else {
      await ref.set({ pipelineStatus: "done", updatedAt: Date.now() }, { merge: true });
    }

    await log({
      level: "success",
      message: `Pipeline complete for "${alienProduct.title}"`,
      vendorId: vendor.id,
      vendorName: vendor.title,
      productId: String(alienProductId),
      productTitle: alienProduct.title,
      step: "system",
    });
    return { ok: true, productDocId: id, shopifyProductGid, toastdProductId };
  } catch (e: any) {
    // ShipTurtle auth errors are transient — let them bubble so the caller can
    // refresh the bearer and retry. Mark the product as "auth_pending" so a
    // restart doesn't think we crashed mid-step.
    if (e instanceof ShipTurtleAuthError) {
      await ref.set({ pipelineStatus: "pending", lastError: e.message, updatedAt: Date.now() }, { merge: true });
      throw e;
    }
    const reason = e instanceof ShopifyAuthError ? "shopify_auth" : "error";
    const titleForLog = (alienProductHint as any)?.title ?? prev?.title;

    // Transactional rollback. Only roll back resources we created in *this*
    // run, and only if the partial product is not yet load-bearing (no images
    // recorded in Toastd). Auth failures aren't rolled back — they're env
    // problems, not data inconsistencies.
    let rolledBack = false;
    if (reason !== "shopify_auth" && (created.shopifyProductGid || created.toastdProductId)) {
      const safe = await canRollback(created.toastdProductId, created.step3ImagesUploaded, settings.toastdAdminToken);
      if (safe) {
        await rollbackProduct(
          vendor,
          alienProductId,
          titleForLog,
          created.shopifyProductGid,
          created.toastdProductId,
          settings,
        );
        rolledBack = true;
      } else {
        await log({
          level: "warn",
          message: `Skipping rollback: product already has images in Toastd DB (preserving user-visible data)`,
          vendorId: vendor.id,
          vendorName: vendor.title,
          productId: String(alienProductId),
          productTitle: titleForLog,
          step: "system",
        });
      }
    }

    await ref.set(
      {
        pipelineStatus: rolledBack ? "rolled_back" : "error",
        lastError: e.message,
        updatedAt: Date.now(),
        // Clear any state we just rolled back — this run is now a clean slate.
        ...(rolledBack
          ? {
              step1: null,
              step2: null,
              step3: null,
            }
          : {}),
      },
      { merge: true },
    );
    await log({
      level: "error",
      message: rolledBack ? `Pipeline failed and rolled back: ${e.message}` : `Pipeline failed: ${e.message}`,
      vendorId: vendor.id,
      vendorName: vendor.title,
      productId: String(alienProductId),
      productTitle: titleForLog,
      step: "system",
      meta: { reason, rolledBack },
    });
    return { ok: false, productDocId: id, reason: e.message };
  }
}

/** Sync all unmapped products of a single vendor. */
export async function syncVendor(
  vendor: VendorRecord,
  opts: RunOpts = {},
): Promise<{ total: number; succeeded: number; failed: number; skipped: number }> {
  const settings = await getSettings();
  if (!vendor.brandId) throw new Error(`vendor ${vendor.title} has no brand mapping`);
  if (!vendor.domain) throw new Error(`vendor ${vendor.title} has no domain`);
  // Only consider active products — ShipTurtle filters server-side.
  const list = await listAllVendorProducts(settings.shipturtleToken, vendor.domain, {
    filters: { status: "active" },
  });
  const targets = list.filter((p: any) => {
    if (p.status && p.status !== "active") return false; // belt-and-suspenders
    if (!p?.merchant_products) return true;
    return p.merchant_products.length === 0;
  });
  await log({
    level: "info",
    message: `Vendor sync starting: ${targets.length} active+unmapped product(s) (out of ${list.length} active)`,
    vendorId: vendor.id,
    vendorName: vendor.title,
    step: "system",
  });
  let processed = 0;
  let succeeded = 0;
  let failed = 0;
  for (const p of targets) {
    await opts.onProgress?.({ processed, total: targets.length, currentTitle: p.title });
    const r = await syncOneProduct(vendor, Number(p.id), p);
    processed += 1;
    if (r.ok) succeeded += 1;
    else failed += 1;
  }
  await Collections.vendors.doc(vendor.id).set(
    {
      lastSyncAt: Date.now(),
      lastSyncStatus: failed === 0 ? "ok" : "error",
      lastError: failed === 0 ? null : `${failed} product(s) failed`,
      updatedAt: Date.now(),
    },
    { merge: true },
  );
  return { total: targets.length, succeeded, failed, skipped: list.length - targets.length };
}
