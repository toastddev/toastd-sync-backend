import { request } from "undici";
import sharp from "sharp";

const BASE = "https://api.toastd.in";

export class ToastdAuthError extends Error {
  constructor(msg = "Toastd auth failed") {
    super(msg);
    this.name = "ToastdAuthError";
  }
}

/**
 * Toastd's /api/ai/product_create returned 404 with the stable reason code
 * `vendor_product_not_found`. The vendor's storefront no longer hosts the
 * product handle (deleted, renamed, or never published). Pipeline catches this
 * as a distinct case — single retry only, then mark the row as
 * `website_product_missing` so the dashboard can show it clearly.
 */
export class VendorProductNotFoundError extends Error {
  constructor(public url: string) {
    super(`Vendor product not found at ${url}`);
    this.name = "VendorProductNotFoundError";
  }
}

function headers(token: string | undefined, extra: Record<string, string> = {}) {
  const h: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json",
    ...extra,
  };
  if (token) h["x-toastd-access-token"] = token;
  return h;
}

async function jsonCall<T = any>(
  method: "GET" | "POST" | "PUT",
  path: string,
  token: string | undefined,
  body?: any,
): Promise<T> {
  const res = await request(`${BASE}${path}`, {
    method,
    headers: headers(token),
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.body.text();
  if (res.statusCode === 401 || res.statusCode === 403) throw new ToastdAuthError(`Toastd ${res.statusCode}`);
  if (res.statusCode >= 400) throw new Error(`Toastd ${method} ${path} ${res.statusCode}: ${text.slice(0, 500)}`);
  return text ? (JSON.parse(text) as T) : ({} as T);
}

export interface ToastdBrand {
  id: string;
  name: string;
  slug: string;
  status?: boolean;
  externalStoreName?: string | null;
  adminAccessToken?: string | null;
  storeAccessToken?: string | null;
}

export async function listBrands(token?: string): Promise<ToastdBrand[]> {
  const r = await jsonCall<any>("GET", "/api/brand?page=0&size=1000&restrictInactive=false", token);
  const arr = r?.data ?? r?.content ?? r?.brands ?? r;
  return Array.isArray(arr) ? arr : [];
}

export async function getBrand(brandId: string, token?: string): Promise<ToastdBrand | null> {
  try {
    return await jsonCall<ToastdBrand>("GET", `/api/brand/${brandId}`, token);
  } catch {
    try {
      const all = await listBrands(token);
      return all.find((b) => b.id === brandId) ?? null;
    } catch {
      return null;
    }
  }
}

export interface ToastdCategory {
  id: string;
  name: string;
  slug: string;
}

/**
 * Loads every Toastd category once per pipeline run so we can resolve the
 * AI-returned `mainCategoryName` to its UUID. Without this the sync would
 * persist `mainCategoryId = null` (the AI endpoint never returns the UUID,
 * only the name), which is what broke admin's UpdateProduct fetch.
 */
export async function listCategories(token?: string): Promise<ToastdCategory[]> {
  const r = await jsonCall<any>("GET", "/api/category", token);
  const arr = Array.isArray(r) ? r : r?.data ?? r?.content ?? [];
  return Array.isArray(arr) ? arr.map((c: any) => ({ id: c.id, name: c.name, slug: c.slug })) : [];
}

/**
 * Lookup an existing product by (brandId, externalProductId). The Shopify sync
 * pipeline calls this BEFORE creating/AI-ing a new product so that a re-sync
 * (or a vendor product already mapped under a different slug) doesn't insert a
 * duplicate row. Returns null on 404; throws on other transport errors.
 */
export async function findExistingProductByBrandAndExternalId(
  brandId: string,
  externalProductId: string,
  token?: string,
): Promise<{ id: string; slug?: string } | null> {
  const qs = `?brandId=${encodeURIComponent(brandId)}&externalProductId=${encodeURIComponent(externalProductId)}`;
  const res = await request(`${BASE}/api/product/by-external${qs}`, {
    method: "GET",
    headers: headers(token),
  });
  const text = await res.body.text();
  if (res.statusCode === 404) return null;
  if (res.statusCode === 401 || res.statusCode === 403) throw new ToastdAuthError(`Toastd by-external ${res.statusCode}`);
  if (res.statusCode >= 400) {
    throw new Error(`Toastd GET by-external ${res.statusCode}: ${text.slice(0, 300)}`);
  }
  if (!text) return null;
  try {
    const parsed = JSON.parse(text);
    if (!parsed?.id) return null;
    return { id: parsed.id, slug: parsed.slug };
  } catch {
    return null;
  }
}

export interface AiProductCreateInput {
  url: string;
  slug: string;
  brandId: string;
  externalId: string;
  price: { amount: string; code: string; symbol: string };
}

export async function aiProductCreate(input: AiProductCreateInput, token?: string) {
  try {
    return await jsonCall<any>("POST", "/api/ai/product_create", token, input);
  } catch (e: any) {
    // Toastd backend returns 404 with reason `vendor_product_not_found` when
    // the vendor's storefront 404s on the product handle. Translate that into
    // a typed error so pipeline.ts can apply the single-retry policy.
    const msg: string = typeof e?.message === "string" ? e.message : "";
    if (msg.includes("404") && msg.includes("vendor_product_not_found")) {
      throw new VendorProductNotFoundError(input.url);
    }
    throw e;
  }
}

export async function createProduct(payload: any, token?: string) {
  return jsonCall<any>("POST", "/api/product", token, payload);
}

/**
 * Try a list of candidate paths in order until one returns 2xx. Lets us tolerate
 * the small inconsistency in the Toastd API doc (file endpoints written without
 * the `/api` prefix while every other endpoint includes it).
 */
async function putWithPathFallback(
  paths: string[],
  token: string | undefined,
  acceptHeader = "text/plain,application/json",
): Promise<{ status: number; text: string }> {
  let last: { status: number; text: string; path: string } | null = null;
  for (const path of paths) {
    const res = await request(`${BASE}${path}`, { method: "PUT", headers: headers(token, { Accept: acceptHeader }) });
    const text = await res.body.text();
    if (res.statusCode < 400) return { status: res.statusCode, text };
    last = { status: res.statusCode, text, path };
    if (res.statusCode === 401 || res.statusCode === 403) throw new ToastdAuthError(`Toastd ${path} ${res.statusCode}`);
    if (res.statusCode !== 404) break;
  }
  throw new Error(`Toastd PUT ${last?.path} ${last?.status}: ${(last?.text ?? "").slice(0, 300)}`);
}

export async function getPresignedUrl(objectKey: string, contentType: string, token?: string): Promise<string> {
  const qs = `?objectKey=${encodeURIComponent(objectKey)}&contentType=${encodeURIComponent(contentType)}`;
  const { text } = await putWithPathFallback(
    [`/api/file/presigned-url${qs}`, `/file/presigned-url${qs}`],
    token,
  );
  try {
    const parsed = JSON.parse(text);
    if (typeof parsed === "string") return parsed;
    return parsed.url ?? parsed;
  } catch {
    return text.replace(/^"|"$/g, "");
  }
}

export async function uploadToGcs(presignedUrl: string, body: Buffer, contentType: string) {
  const res = await request(presignedUrl, {
    method: "PUT",
    headers: { "Content-Type": contentType },
    body,
  });
  if (res.statusCode >= 400) {
    const t = await res.body.text();
    throw new Error(`GCS upload ${res.statusCode}: ${t.slice(0, 300)}`);
  }
  await res.body.text();
}

/**
 * POST a JSON body, trying `/api/<path>` first and falling back to `/<path>`
 * on 404. Mirrors the file-doc inconsistency tolerated by `putWithPathFallback`.
 */
async function postJsonWithPathFallback<T = any>(
  paths: string[],
  body: any,
  token?: string,
): Promise<T> {
  let last: { status: number; text: string; path: string } | null = null;
  for (const path of paths) {
    const res = await request(`${BASE}${path}`, {
      method: "POST",
      headers: headers(token),
      body: JSON.stringify(body),
    });
    const text = await res.body.text();
    if (res.statusCode === 401 || res.statusCode === 403) throw new ToastdAuthError(`Toastd ${path} ${res.statusCode}`);
    if (res.statusCode < 400) return (text ? JSON.parse(text) : ({} as T));
    last = { status: res.statusCode, text, path };
    if (res.statusCode !== 404) break;
  }
  throw new Error(`Toastd POST ${last?.path} ${last?.status}: ${(last?.text ?? "").slice(0, 300)}`);
}

export async function recordFile(payload: {
  name: string;
  url: string;
  fileType: "image";
  productId: string;
  alt?: string | null;
  thumbnailUrl?: string | null;
  variant?: string | null;
}, token?: string) {
  return postJsonWithPathFallback<any>(
    ["/api/file", "/file"],
    { alt: null, thumbnailUrl: null, variant: null, ...payload },
    token,
  );
}

/** Lists all files attached to a product. Used by the rollback path to decide
 *  whether the product is "in use" (has images) and should not be deleted. */
export async function listProductFiles(productId: string, token?: string): Promise<any[]> {
  let last: { status: number; text: string; path: string } | null = null;
  for (const path of [`/api/file?productId=${encodeURIComponent(productId)}`, `/file?productId=${encodeURIComponent(productId)}`]) {
    const res = await request(`${BASE}${path}`, { method: "GET", headers: headers(token) });
    const text = await res.body.text();
    if (res.statusCode === 401 || res.statusCode === 403) throw new ToastdAuthError(`Toastd ${path} ${res.statusCode}`);
    if (res.statusCode < 400) {
      try {
        const parsed = text ? JSON.parse(text) : null;
        if (Array.isArray(parsed)) return parsed;
        if (Array.isArray(parsed?.data)) return parsed.data;
        if (Array.isArray(parsed?.content)) return parsed.content;
        return [];
      } catch {
        return [];
      }
    }
    last = { status: res.statusCode, text, path };
    if (res.statusCode !== 404) break;
  }
  // Best-effort lookup — if the endpoint doesn't exist, treat as "no files known".
  if (last?.status === 404) return [];
  throw new Error(`Toastd GET files ${last?.status}: ${(last?.text ?? "").slice(0, 300)}`);
}

export async function deleteToastdProduct(productId: string, token?: string): Promise<void> {
  let last: { status: number; text: string; path: string } | null = null;
  for (const path of [`/api/product/${encodeURIComponent(productId)}`, `/product/${encodeURIComponent(productId)}`]) {
    const res = await request(`${BASE}${path}`, { method: "DELETE", headers: headers(token) });
    const text = await res.body.text();
    if (res.statusCode === 401 || res.statusCode === 403) throw new ToastdAuthError(`Toastd ${path} ${res.statusCode}`);
    if (res.statusCode < 400 || res.statusCode === 404) return; // 404 = already gone, treat as success
    last = { status: res.statusCode, text, path };
  }
  throw new Error(`Toastd DELETE product ${last?.status}: ${(last?.text ?? "").slice(0, 300)}`);
}

export async function downloadAndConvertWebp(srcUrl: string): Promise<Buffer> {
  const res = await request(srcUrl, { method: "GET" });
  if (res.statusCode >= 400) throw new Error(`download ${srcUrl} -> ${res.statusCode}`);
  const ab = await res.body.arrayBuffer();
  const input = Buffer.from(ab);
  return sharp(input)
    .resize({ width: 4096, height: 4096, fit: "inside", withoutEnlargement: true })
    .webp({ quality: 88 })
    .toBuffer();
}

export const ASSETS_BASE_URL = "https://assets.toastd.in";

/**
 * Warm the CDN edge for a just-uploaded asset by issuing a GET against the
 * public URL. GCS writes are strongly consistent at the bucket but the
 * assets.toastd.in CDN in front of it sits idle until something asks for the
 * key — without this nudge the frontend's first <img> request paid the cold
 * fetch latency and occasionally rendered a placeholder before the byte
 * arrived. Best-effort only; never throw — the upload itself has already
 * landed by the time we get here.
 */
export async function warmAssetUrl(assetUrl: string): Promise<void> {
  try {
    const res = await request(assetUrl, { method: "GET" });
    // Drain so the connection can be reused / GC'd.
    await res.body.arrayBuffer().catch(() => {});
  } catch {
    /* swallow — warmup is opportunistic */
  }
}
