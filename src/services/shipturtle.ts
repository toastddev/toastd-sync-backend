import { request } from "undici";

const BASE = "https://api-v2.shipturtle.com";

// ──────────────────────────────────────────────────────────────────────────────
// OAuth token refresh
//
// ShipTurtle's bearer token expires (~15 days). When auto-refresh is enabled in
// Settings the dashboard can re-mint a new bearer either from:
//   - a stored refresh_token (preferred — short hop), or
//   - the saved username/password/client_id/client_secret (password grant).
// Both calls return { access_token, refresh_token, expires_in }.

export interface ShipTurtleOAuthCreds {
  username?: string;
  password?: string;
  clientId?: string;
  clientSecret?: string;
  refreshToken?: string;
}

export interface ShipTurtleTokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  token_type: string;
}

async function postOAuth(body: Record<string, string>): Promise<ShipTurtleTokenResponse> {
  const res = await request(`${BASE}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(body),
  });
  const text = await res.body.text();
  if (res.statusCode >= 400) {
    throw new Error(`ShipTurtle oauth/token ${res.statusCode}: ${text.slice(0, 400)}`);
  }
  return JSON.parse(text) as ShipTurtleTokenResponse;
}

/** Re-mint a bearer from the stored refresh_token first, falling back to password grant. */
export async function refreshShipTurtleToken(creds: ShipTurtleOAuthCreds): Promise<ShipTurtleTokenResponse> {
  if (!creds.clientId || !creds.clientSecret) {
    throw new Error("ShipTurtle auto-refresh requires client_id and client_secret");
  }
  if (creds.refreshToken) {
    try {
      return await postOAuth({
        grant_type: "refresh_token",
        refresh_token: creds.refreshToken,
        client_id: creds.clientId,
        client_secret: creds.clientSecret,
      });
    } catch {
      // fall through to password grant if refresh token is rejected (expired/revoked)
    }
  }
  if (!creds.username || !creds.password) {
    throw new Error("ShipTurtle auto-refresh needs username + password when refresh_token is missing/invalid");
  }
  return postOAuth({
    grant_type: "password",
    username: creds.username,
    password: creds.password,
    client_id: creds.clientId,
    client_secret: creds.clientSecret,
  });
}

function authHeaders(token: string) {
  return {
    Authorization: token.startsWith("Bearer ") ? token : `Bearer ${token}`,
    "Content-Type": "application/json",
    Accept: "application/json",
  };
}

export class ShipTurtleAuthError extends Error {
  constructor(msg = "ShipTurtle auth failed") {
    super(msg);
    this.name = "ShipTurtleAuthError";
  }
}

async function call<T = any>(path: string, init: { method: "GET" | "POST"; body?: any; token: string }): Promise<T> {
  const res = await request(`${BASE}${path}`, {
    method: init.method,
    headers: authHeaders(init.token),
    body: init.body ? JSON.stringify(init.body) : undefined,
  });
  const text = await res.body.text();
  if (res.statusCode === 401 || res.statusCode === 403) throw new ShipTurtleAuthError(`ShipTurtle ${res.statusCode}`);
  if (res.statusCode >= 400) throw new Error(`ShipTurtle ${path} ${res.statusCode}: ${text.slice(0, 400)}`);
  try {
    return text ? (JSON.parse(text) as T) : ({} as T);
  } catch {
    return text as unknown as T;
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// Datatable payload builder

interface Column {
  data: string;
  searchable?: boolean;
  orderable?: boolean;
  /** When set, becomes a per-column filter (e.g. exact title match). */
  filter?: string;
}

interface DatatableOpts {
  columns: Column[];
  search?: string;
  start?: number;
  length?: number;
  query?: Record<string, unknown>;
}

function buildDatatablePayload(opts: DatatableOpts) {
  return {
    columns: opts.columns.map((col) => ({
      data: col.data,
      name: col.data,
      searchable: col.searchable ?? true,
      orderable: col.orderable ?? false,
      search: { value: col.filter ?? "", regex: false },
    })),
    order: [{ column: 0, dir: false }],
    start: opts.start ?? 0,
    length: opts.length ?? 10,
    search: { value: opts.search ?? "" },
    query: opts.query ?? {},
  };
}

const VENDOR_COLUMNS: Column[] = [
  { data: "created_at", searchable: false, orderable: true },
  { data: "logo", searchable: false },
  { data: "id", orderable: true },
  { data: "vendor_summary.vendor_type" },
  { data: "email", searchable: false, orderable: true },
  { data: "vendor_summary.products", orderable: true },
  { data: "inventory_location", searchable: false },
  { data: "vendor_summary.total_sales", searchable: false },
  { data: "vendor_summary.vendor_earnings", searchable: false },
  { data: "vendor_summary.pending_amount", searchable: false },
  { data: "action", searchable: false },
];

const PRODUCT_COLUMNS: Column[] = [
  { data: "created_at", searchable: false, orderable: true },
  { data: "image", searchable: false },
  { data: "title" },
  { data: "data-table-expand", searchable: false },
  { data: "product_type" },
  { data: "tags" },
  { data: "status" },
  { data: "quantity" },
  { data: "mapping_status" },
  { data: "action", searchable: false },
];

interface DatatableResponse<T> {
  draw: number;
  recordsTotal: number;
  recordsFiltered: number;
  data: T[];
}

// ──────────────────────────────────────────────────────────────────────────────
// Vendors

export interface VendorSearchOpts {
  search?: string;
  start?: number;
  length?: number;
}

/** Server-side search of approved vendors (paginated). */
export async function searchApprovedVendors(token: string, opts: VendorSearchOpts = {}): Promise<DatatableResponse<any>> {
  const payload = buildDatatablePayload({
    columns: VENDOR_COLUMNS,
    search: opts.search,
    start: opts.start ?? 0,
    length: opts.length ?? 50,
  });
  const data = await call<DatatableResponse<any>>("/api/v3/vendors/approved", { method: "POST", token, body: payload });
  return { ...data, data: data.data ?? [] };
}

/**
 * Find a single vendor in ShipTurtle by the dashboard's stored doc-id (which is
 * `vendor_shop.id` for shop-backed vendors, else parent `id`). Cheap path first
 * (search by name hint), expensive paginated fallback only if that fails.
 */
export async function findVendorByDocId(
  token: string,
  docId: string,
  hint: { name?: string | null; vendorShopId?: number | null; parentVendorId?: number | null } = {},
): Promise<any | null> {
  const matches = (v: any) => {
    const shopId = Number(v.vendor_shop?.id ?? v.vendor_shop_id);
    const parentId = Number(v.id);
    if (!Number.isNaN(shopId) && String(shopId) === docId) return true;
    if (hint.vendorShopId && shopId === hint.vendorShopId) return true;
    if (hint.parentVendorId && parentId === hint.parentVendorId) return true;
    if (!Number.isNaN(parentId) && String(parentId) === docId) return true;
    return false;
  };

  // 1) Cheap: name-hint search (ShipTurtle's `search.value` is fuzzy).
  if (hint.name) {
    try {
      const r = await searchApprovedVendors(token, { search: hint.name, length: 50 });
      const hit = r.data.find(matches);
      if (hit) return hit;
    } catch {
      // fall through to paginated scan
    }
  }

  // 2) Fallback: paginated scan, capped to keep latency bounded.
  let start = 0;
  const length = 200;
  const cap = 5_000;
  while (start < cap) {
    const r = await searchApprovedVendors(token, { start, length });
    const hit = r.data.find(matches);
    if (hit) return hit;
    if (r.data.length < length) break;
    if (start + r.data.length >= (r.recordsTotal ?? 0)) break;
    start += length;
  }
  return null;
}

/** Page through every approved vendor. Used by full-refresh worker. */
export async function listApprovedVendors(token: string): Promise<any[]> {
  const out: any[] = [];
  const length = 200;
  let start = 0;
  while (true) {
    const r = await searchApprovedVendors(token, { start, length });
    out.push(...r.data);
    if (out.length >= r.recordsTotal || r.data.length === 0) break;
    start += length;
    if (start > 10_000) break; // safety cap
  }
  return out;
}

// ──────────────────────────────────────────────────────────────────────────────
// Vendor products

export type ProductColumnFilter = {
  title?: string;
  product_type?: string;
  tags?: string;
  status?: string;
  quantity?: string;
  mapping_status?: string;
};

export interface VendorProductSearchOpts {
  search?: string;
  start?: number;
  length?: number;
  filters?: ProductColumnFilter;
}

/** Server-side search of a vendor's products (paginated, with per-column filters). */
export async function searchVendorProducts(
  token: string,
  vendorDomain: string,
  opts: VendorProductSearchOpts = {},
): Promise<DatatableResponse<any>> {
  const filters = opts.filters ?? {};
  const columns = PRODUCT_COLUMNS.map((c) => {
    const f = (filters as any)[c.data];
    return f ? { ...c, filter: String(f) } : c;
  });
  const payload = buildDatatablePayload({
    columns,
    search: opts.search,
    start: opts.start ?? 0,
    length: opts.length ?? 50,
    query: { vendor: vendorDomain },
  });
  const data = await call<DatatableResponse<any>>(
    "/api/v3/multi-store/fetch-data-alien",
    { method: "POST", token, body: payload },
  );
  return { ...data, data: data.data ?? [] };
}

/** Convenience: fetch first N products of a vendor (used internally by the pipeline). */
export async function fetchVendorProducts(token: string, vendorDomain: string, length = 200) {
  const r = await searchVendorProducts(token, vendorDomain, { length });
  return r.data;
}

/** Page through every product of a vendor. Used by sync + drift workers. */
export async function listAllVendorProducts(
  token: string,
  vendorDomain: string,
  opts: Pick<VendorProductSearchOpts, "filters" | "search"> = {},
): Promise<any[]> {
  const out: any[] = [];
  const length = 200;
  let start = 0;
  while (true) {
    const r = await searchVendorProducts(token, vendorDomain, { ...opts, start, length });
    out.push(...r.data);
    // ShipTurtle returns recordsFiltered as the count after filters; use it as the upper bound.
    const cap = r.recordsFiltered ?? r.recordsTotal ?? 0;
    if (out.length >= cap || r.data.length === 0) break;
    start += length;
    if (start > 20_000) break;
  }
  return out;
}

/** Look up a single product by exact title (server-side title filter). */
export async function findProductByTitle(token: string, vendorDomain: string, title: string) {
  const r = await searchVendorProducts(token, vendorDomain, {
    filters: { title },
    length: 25,
  });
  return r.data;
}

// ──────────────────────────────────────────────────────────────────────────────
// Status / counts / mutate

export async function checkVendorShopStatus(token: string, vendorShopId: number) {
  return call<{ is_frozen: boolean }>(`/api/v3/vendors/check-shop-status?vendor_shop_id=${vendorShopId}`, {
    method: "GET",
    token,
  });
}

export async function vendorShopMappedCount(token: string, vendorShopId: number) {
  return call<{ mapped_products: number; total_products: number }>(
    `/api/v1/fetch-vendor-shop-mapped-count?vendor_shop_id=${vendorShopId}`,
    { method: "GET", token },
  );
}

/** Step 1: trigger ShipTurtle to push the alien product into the merchant store. */
export async function addVendorProduct(token: string, alienProductId: number) {
  const form = new FormData();
  form.append("alien_product_id", String(alienProductId));
  const res = await request(`${BASE}/api/v1/add-vendor-product`, {
    method: "POST",
    headers: {
      Authorization: token.startsWith("Bearer ") ? token : `Bearer ${token}`,
      Accept: "application/json",
    },
    body: form as any,
  });
  const text = await res.body.text();
  if (res.statusCode === 401 || res.statusCode === 403) throw new ShipTurtleAuthError();
  if (res.statusCode >= 400) throw new Error(`add-vendor-product ${res.statusCode}: ${text.slice(0, 400)}`);
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    return { raw: text };
  }
}

export function deriveMappingStatus(p: any): "FULLY_MAPPED" | "PARTIALLY_MAPPED" | "UNMAPPED" {
  if (!p?.merchant_products || p.merchant_products.length === 0) return "UNMAPPED";
  const total = p.variants?.length || 0;
  const mapped = (p.variants || []).filter((v: any) => v.merchant_variants && v.merchant_variants.length > 0).length;
  if (mapped === 0) return "UNMAPPED";
  if (mapped === total) return "FULLY_MAPPED";
  return "PARTIALLY_MAPPED";
}
