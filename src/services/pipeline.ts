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
  VendorProductNotFoundError,
  warmAssetUrl,
} from "./toastd.js";
import { getSettings } from "../routes/settings.js";
import type { ProductRecord, Settings, VendorRecord } from "../types.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Thrown by Step 3b when the Toastd backend reports a product with the same
 * slug already exists. The catch path special-cases this to delete the
 * just-created Shopify product (which is now an orphan) and to mark the run
 * as "skipped_existing" rather than a true error.
 */
export class ProductAlreadyExistsError extends Error {
  constructor(public existingToastdProductId: string, public slug: string) {
    super(`Toastd product with slug "${slug}" already exists (id=${existingToastdProductId})`);
    this.name = "ProductAlreadyExistsError";
  }
}

/**
 * Thrown by Step 3c when at least one image upload failed. The catch path
 * unconditionally rolls back the partial Shopify + Toastd state (overriding
 * the usual "preserve images" guard) and re-enqueues up to MAX_PIPELINE_RETRIES
 * times so transient network/GCS failures don't leave a half-built product.
 */
export class IncompleteImageUploadError extends Error {
  constructor(
    public toastdProductId: string,
    public uploaded: number,
    public failed: number,
  ) {
    super(`Step 3c incomplete: ${uploaded} uploaded, ${failed} failed for productId=${toastdProductId}`);
    this.name = "IncompleteImageUploadError";
  }
}

export const MAX_PIPELINE_RETRIES = 3;
// Vendor-product-missing is almost certainly permanent (deleted/renamed
// handle), but we allow a single re-attempt in case the vendor briefly
// unpublished/republished. After 1 retry we give up and mark the row.
export const MAX_VENDOR_MISSING_RETRIES = 1;

export interface RunOpts {
  jobId?: string;
  onProgress?: (p: { processed: number; total: number; currentTitle?: string }) => Promise<void> | void;
  onRetryRequested?: (info: { vendorId: string; alienProductId: number; attempt: number }) => Promise<void> | void;
  onStep?: (info: { step: string; progress?: number }) => Promise<void> | void;
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
  onTotalImages?: (n: number) => void,
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
  // Toastd returns existed:true when a row with the same slug was already in
  // the DB. Don't claim ownership of it (no onProductCreated callback) and
  // don't run Step 3c — the existing product likely already has curated images
  // we don't want to overwrite. Caller catches and rolls back the Shopify
  // product we created upstream so no orphan remains.
  if (created.existed === true) {
    await log({
      level: "warn",
      message: `Step 3b: Toastd product with slug "${productPayload.slug}" already exists (id=${newProductId}); rolling back Shopify orphan`,
      vendorId: vendor.id,
      vendorName: vendor.title,
      productId: newProductId,
      productTitle: alienProduct.title,
      step: "step3b",
    });
    throw new ProductAlreadyExistsError(newProductId, productPayload.slug);
  }
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
  // Tell the caller how many images we're about to attempt so its progress
  // bar can show denominator-aware percentages from the very first upload.
  onTotalImages?.(rawimage.length);
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
      const assetUrl = `${ASSETS_BASE_URL}/${objectKey}`;
      await recordFile({
        name: fileName,
        url: assetUrl,
        fileType: "image",
        productId: newProductId,
        alt: null,
        thumbnailUrl: null,
        variant: null,
      }, tdTok);
      // CDN warm-up: GET the public asset URL so assets.toastd.in caches the
      // object at the edge. Without this the first time the storefront asks
      // for the image it pays the origin round-trip and can briefly 404 /
      // serve a placeholder. Awaited so the storefront never sees a colder
      // edge than the pipeline did.
      await warmAssetUrl(assetUrl);
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
  // Strict completeness: any failed image reverts the whole pipeline so the
  // product never lands in Toastd with a missing thumbnail. Caller catches
  // this, rolls back Shopify + Toastd, increments retryCount, and re-enqueues
  // up to MAX_PIPELINE_RETRIES.
  if (imagesFailed > 0) {
    throw new IncompleteImageUploadError(newProductId, imagesUploaded, imagesFailed);
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
  onRetryRequested?: (info: { vendorId: string; alienProductId: number; attempt: number }) => Promise<void> | void,
  onStep?: (info: { step: string; progress?: number }) => void | Promise<void>,
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
    await onStep?.({ step: "step1", progress: 0 });
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
    await onStep?.({ step: "step2", progress: 0 });
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
    await onStep?.({ step: "step3", progress: 0 });
    let toastdProductId: string | undefined = prev.step3?.toastdProductId;
    if (!prev.step3?.completedAt) {
      // Track expected image count once we have it from runStep3's progress
      // calls; combined with onImageUploaded ticks this gives a 0–100% bar.
      let totalImages = 0;
      let uploadedImages = 0;
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
        // Reaching step 3b means image upload is about to start; bump the bar
        // to ~50% so the user sees movement before the first image lands.
        await onStep?.({ step: "step3", progress: 50 });
      }, () => {
        created.step3ImagesUploaded += 1;
        uploadedImages += 1;
        if (totalImages > 0) {
          // Half the bar is "got to step3c"; the other half tracks images.
          const pct = 50 + Math.min(50, Math.round((uploadedImages / totalImages) * 50));
          // Fire-and-forget — no need to await the in-memory bumpJob mutation.
          void onStep?.({ step: "step3", progress: pct });
        }
      }, (n: number) => {
        totalImages = n;
      });
      toastdProductId = r3.toastdProductId;
      await ref.set(
        {
          step3: { completedAt: Date.now(), toastdProductId, imagesUploaded: r3.imagesUploaded, imagesFailed: r3.imagesFailed, error: null },
          pipelineStatus: "done",
          retryCount: 0,
          updatedAt: Date.now(),
        },
        { merge: true },
      );
    } else {
      await ref.set({ pipelineStatus: "done", retryCount: 0, updatedAt: Date.now() }, { merge: true });
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
    const alreadyExists = e instanceof ProductAlreadyExistsError;
    const incompleteImages = e instanceof IncompleteImageUploadError;
    const websiteMissing = e instanceof VendorProductNotFoundError;
    const reason = e instanceof ShopifyAuthError
      ? "shopify_auth"
      : alreadyExists
      ? "already_exists"
      : incompleteImages
      ? "incomplete_images"
      : websiteMissing
      ? "website_product_missing"
      : "error";
    const titleForLog = (alienProductHint as any)?.title ?? prev?.title;

    // Transactional rollback. Normally we only roll back when the partial
    // product is not yet load-bearing (no images in Toastd). But for the
    // partial-image-upload and website-missing retry paths we MUST roll back
    // unconditionally — a half-imaged or referenced-but-deleted product is
    // exactly what we're avoiding by re-enqueuing or marking missing.
    let rolledBack = false;
    if (reason !== "shopify_auth" && (created.shopifyProductGid || created.toastdProductId)) {
      const safe = incompleteImages || websiteMissing
        ? true
        : await canRollback(created.toastdProductId, created.step3ImagesUploaded, settings.toastdAdminToken);
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

    // Retry policy: bump retryCount and request a re-enqueue from the caller
    // (routes/sync.ts owns the in-process queue). Only kick the retry when we
    // actually rolled back; a stuck rollback means manual review.
    //   - Partial image upload: up to MAX_PIPELINE_RETRIES (3) — usually
    //     transient network/GCS issue.
    //   - Vendor product missing: up to MAX_VENDOR_MISSING_RETRIES (1) — the
    //     handle is almost certainly permanently gone, but a single retry
    //     covers a vendor briefly unpublishing/republishing.
    let willRetry = false;
    const retryEligible = (incompleteImages || websiteMissing) && rolledBack;
    if (retryEligible) {
      const budget = websiteMissing ? MAX_VENDOR_MISSING_RETRIES : MAX_PIPELINE_RETRIES;
      const cause = websiteMissing ? "website product missing" : "partial image upload";
      const nextRetry = (prev?.retryCount ?? 0) + 1;
      if (nextRetry <= budget) {
        willRetry = true;
        await ref.set({ retryCount: nextRetry, updatedAt: Date.now() }, { merge: true });
        try {
          await onRetryRequested?.({ vendorId: vendor.id, alienProductId, attempt: nextRetry });
        } catch (re: any) {
          await log({
            level: "warn",
            message: `Retry re-enqueue failed (continuing): ${re.message}`,
            vendorId: vendor.id,
            vendorName: vendor.title,
            productId: String(alienProductId),
            productTitle: titleForLog,
            step: "system",
          }).catch(() => {});
        }
        await log({
          level: "warn",
          message: `Pipeline retry ${nextRetry}/${budget}: re-enqueued after ${cause}`,
          vendorId: vendor.id,
          vendorName: vendor.title,
          productId: String(alienProductId),
          productTitle: titleForLog,
          step: "system",
        });
      } else {
        await log({
          level: "error",
          message: `Pipeline retry exhausted (${budget} attempt${budget === 1 ? "" : "s"}) — giving up after ${cause}`,
          vendorId: vendor.id,
          vendorName: vendor.title,
          productId: String(alienProductId),
          productTitle: titleForLog,
          step: "system",
        });
      }
    }

    const finalStatus = alreadyExists
      ? "skipped_existing"
      : willRetry
      ? "pending"
      : websiteMissing
      ? "website_product_missing"
      : rolledBack
      ? "rolled_back"
      : "error";
    // For already-exists, persist the link to the pre-existing Toastd product
    // so the dashboard can show "mapped (to existing)" rather than treating
    // this row as orphaned. We rolled back our own Shopify create above, so
    // clear step1/step2 — only step3 retains the existing productId.
    const existingId = alreadyExists ? (e as ProductAlreadyExistsError).existingToastdProductId : null;
    await ref.set(
      {
        pipelineStatus: finalStatus,
        lastError: alreadyExists ? null : e.message,
        updatedAt: Date.now(),
        // Clear any state we just rolled back — this run is now a clean slate
        // (also true for the retry case so the next attempt restarts from
        // step 1 against fresh Shopify + Toastd resources).
        ...(rolledBack && !alreadyExists
          ? {
              step1: null,
              step2: null,
              step3: null,
            }
          : {}),
        ...(alreadyExists
          ? {
              step1: null,
              step2: null,
              step3: {
                completedAt: Date.now(),
                toastdProductId: existingId,
                imagesUploaded: 0,
                imagesFailed: 0,
                error: null,
                fromExisting: true,
              },
            }
          : {}),
      },
      { merge: true },
    );
    await log({
      level: alreadyExists || willRetry || websiteMissing ? "warn" : "error",
      message: alreadyExists
        ? `Pipeline skipped: ${e.message}; Shopify orphan ${rolledBack ? "rolled back" : "left in place"}`
        : willRetry
        ? `Pipeline rolled back and re-enqueued for retry: ${e.message}`
        : websiteMissing
        ? `Vendor product no longer exists on its storefront — marked website_product_missing: ${e.message}`
        : rolledBack ? `Pipeline failed and rolled back: ${e.message}` : `Pipeline failed: ${e.message}`,
      vendorId: vendor.id,
      vendorName: vendor.title,
      productId: String(alienProductId),
      productTitle: titleForLog,
      step: "system",
      meta: { reason, rolledBack, willRetry },
    });
    // Already-exists isn't a failure — the goal (this product is in Toastd) is
    // achieved. Retries-in-flight are also reported as ok so the queue counter
    // doesn't tick "failed" for an attempt we're about to redo. Website-missing
    // IS a failure (we couldn't sync) but a deterministic one — caller still
    // sees ok:false so the vendor sync's "failed" counter reflects reality.
    return { ok: alreadyExists || willRetry, productDocId: id, reason: e.message };
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
    // Pass the retry hook through — vendor sync runs are bulk operations so we
    // also want partial-image failures to retry rather than land as -1 success.
    const r = await syncOneProduct(vendor, Number(p.id), p, opts.onRetryRequested, opts.onStep);
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
