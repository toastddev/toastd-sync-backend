import { request } from "undici";

export class ShopifyAuthError extends Error {
  constructor(msg = "Shopify auth failed") {
    super(msg);
    this.name = "ShopifyAuthError";
  }
}

const TOASTD_PUBLICATION_NAME_HINTS = ["toastd"]; // case-insensitive substring match

export interface ShopifyCreds {
  domain: string; // e.g. toastd-merchant.myshopify.com
  adminToken: string;
}

export function normalizeShopDomain(input: string): string {
  let d = (input || "").trim().toLowerCase();
  d = d.replace(/^https?:\/\//, "");
  const adminMatch = d.match(/^admin\.shopify\.com\/store\/([a-z0-9-]+)/);
  if (adminMatch) return `${adminMatch[1]}.myshopify.com`;
  d = d.replace(/\/.*$/, "");
  d = d.replace(/\.shopify\.com$/, ".myshopify.com");
  if (!d.includes(".") && /^[a-z0-9-]+$/.test(d)) {
    return `${d}.myshopify.com`;
  }
  return d;
}

async function gql<T = any>(creds: ShopifyCreds, query: string, variables?: any): Promise<T> {
  const domain = normalizeShopDomain(creds.domain);
  if (!/^[a-z0-9-]+\.myshopify\.com$/.test(domain)) {
    throw new Error(`Invalid Shopify domain "${creds.domain}". Expected your store handle (e.g. "i7c0rd-qi") or "i7c0rd-qi.myshopify.com".`);
  }
  const url = `https://${domain}/admin/api/2024-10/graphql.json`;
  const res = await request(url, {
    method: "POST",
    headers: {
      "X-Shopify-Access-Token": creds.adminToken,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({ query, variables }),
  });
  const text = await res.body.text();
  if (res.statusCode === 401 || res.statusCode === 403) throw new ShopifyAuthError(`Shopify ${res.statusCode}`);
  if (res.statusCode >= 400) throw new Error(`Shopify GQL ${res.statusCode}: ${text.slice(0, 500)}`);
  const json = JSON.parse(text);
  if (json.errors?.length) {
    const msg = json.errors.map((e: any) => e.message).join("; ");
    if (/access denied|invalid api key/i.test(msg)) throw new ShopifyAuthError(msg);
    throw new Error(`Shopify GQL errors: ${msg}`);
  }
  return json.data as T;
}

export async function whoAmI(creds: ShopifyCreds) {
  const data = await gql<any>(creds, `{ shop { id name myshopifyDomain } }`);
  return data?.shop;
}

export async function listPublications(creds: ShopifyCreds) {
  const data = await gql<any>(
    creds,
    `query { publications(first: 50) { edges { node { id name } } } }`,
  );
  return (data?.publications?.edges ?? []).map((e: any) => e.node) as Array<{ id: string; name: string }>;
}

export async function findToastdPublicationIds(creds: ShopifyCreds, hint?: string) {
  const pubs = await listPublications(creds);
  const onlineStore = pubs.find((p) => /online store/i.test(p.name));
  let toastdPub: { id: string; name: string } | undefined;
  if (hint) toastdPub = pubs.find((p) => p.name.toLowerCase() === hint.toLowerCase());
  if (!toastdPub) {
    toastdPub = pubs.find((p) => TOASTD_PUBLICATION_NAME_HINTS.some((h) => p.name.toLowerCase().includes(h)));
  }
  return { onlineStore, toastdPub, all: pubs };
}

export async function findRecentProductByTitle(creds: ShopifyCreds, title: string, vendorName?: string) {
  // Use products query with text search; sort by created_at desc.
  const q = vendorName ? `title:${JSON.stringify(title)} vendor:${JSON.stringify(vendorName)}` : `title:${JSON.stringify(title)}`;
  const data = await gql<any>(
    creds,
    `query($q: String!) {
       products(first: 5, query: $q, sortKey: CREATED_AT, reverse: true) {
         edges { node { id title handle vendor createdAt status } }
       }
     }`,
    { q },
  );
  return (data?.products?.edges ?? []).map((e: any) => e.node);
}

export async function publishToPublications(creds: ShopifyCreds, productGid: string, publicationIds: string[]) {
  if (publicationIds.length === 0) return;
  const input = publicationIds.map((id) => ({ publicationId: id }));
  const data = await gql<any>(
    creds,
    `mutation($id: ID!, $input: [PublicationInput!]!) {
       publishablePublish(id: $id, input: $input) {
         publishable { availablePublicationsCount { count } }
         userErrors { field message }
       }
     }`,
    { id: productGid, input },
  );
  const errs = data?.publishablePublish?.userErrors ?? [];
  if (errs.length) throw new Error(`publishablePublish errors: ${errs.map((e: any) => e.message).join("; ")}`);
}

/**
 * Hard-delete a Shopify product. ShipTurtle treats this as the "unmap" signal
 * and clears its merchant_products mapping automatically on the next poll.
 * Idempotent — a 404-shaped userError (already gone) is tolerated.
 */
export async function deleteShopifyProduct(creds: ShopifyCreds, productGid: string): Promise<void> {
  const data = await gql<any>(
    creds,
    `mutation($input: ProductDeleteInput!) {
       productDelete(input: $input) {
         deletedProductId
         userErrors { field message }
       }
     }`,
    { input: { id: productGid } },
  );
  const errs = (data?.productDelete?.userErrors ?? []) as Array<{ message: string }>;
  const benign = errs.every((e) => /not found|does not exist/i.test(e.message));
  if (errs.length && !benign) {
    throw new Error(`productDelete errors: ${errs.map((e) => e.message).join("; ")}`);
  }
}

export async function getProduct(creds: ShopifyCreds, productGid: string) {
  const data = await gql<any>(
    creds,
    `query($id: ID!) {
       product(id: $id) {
         id title handle vendor status createdAt
         variants(first: 100) { edges { node { id title sku price inventoryQuantity inventoryPolicy inventoryItem { id tracked } } } }
       }
     }`,
    { id: productGid },
  );
  return data?.product;
}

/**
 * Resolve the GID of the store's primary location. Cached per process so we
 * don't pay the round-trip on every product sync.
 */
let _primaryLocationCache: { domain: string; id: string } | null = null;
export async function getPrimaryLocationId(creds: ShopifyCreds): Promise<string> {
  const domain = normalizeShopDomain(creds.domain);
  if (_primaryLocationCache && _primaryLocationCache.domain === domain) return _primaryLocationCache.id;
  const data = await gql<any>(
    creds,
    `query { locations(first: 10) { edges { node { id name isActive fulfillsOnlineOrders } } } }`,
  );
  const nodes: Array<{ id: string; name: string; isActive: boolean; fulfillsOnlineOrders: boolean }> =
    (data?.locations?.edges ?? []).map((e: any) => e.node);
  if (nodes.length === 0) throw new Error("Shopify store has no locations");
  const pick = nodes.find((n) => n.isActive && n.fulfillsOnlineOrders) ?? nodes.find((n) => n.isActive) ?? nodes[0];
  _primaryLocationCache = { domain, id: pick.id };
  return pick.id;
}

interface ShopifyVariantRow {
  id: string;
  title?: string;
  inventoryPolicy: string;
  inventoryItem: { id: string; tracked: boolean };
}

async function flipTrackingForVariants(creds: ShopifyCreds, variants: ShopifyVariantRow[]) {
  let itemsUpdated = 0;
  for (const v of variants) {
    if (v.inventoryItem?.tracked) continue;
    const data = await gql<any>(
      creds,
      `mutation($id: ID!, $input: InventoryItemInput!) {
         inventoryItemUpdate(id: $id, input: $input) {
           inventoryItem { id tracked }
           userErrors { field message }
         }
       }`,
      { id: v.inventoryItem.id, input: { tracked: true } },
    );
    const errs = data?.inventoryItemUpdate?.userErrors ?? [];
    if (errs.length) throw new Error(`inventoryItemUpdate errors: ${errs.map((e: any) => e.message).join("; ")}`);
    itemsUpdated += 1;
  }
  return itemsUpdated;
}

async function denyOversellForVariants(creds: ShopifyCreds, productGid: string, variants: ShopifyVariantRow[]) {
  const variantsToDeny = variants.filter((v) => v.inventoryPolicy !== "DENY").map((v) => ({ id: v.id, inventoryPolicy: "DENY" }));
  if (variantsToDeny.length === 0) return 0;
  const data = await gql<any>(
    creds,
    `mutation($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
       productVariantsBulkUpdate(productId: $productId, variants: $variants) {
         productVariants { id inventoryPolicy }
         userErrors { field message }
       }
     }`,
    { productId: productGid, variants: variantsToDeny },
  );
  const errs = data?.productVariantsBulkUpdate?.userErrors ?? [];
  if (errs.length) throw new Error(`productVariantsBulkUpdate errors: ${errs.map((e: any) => e.message).join("; ")}`);
  return variantsToDeny.length;
}

/**
 * Activate every inventory item at the given location. `inventoryActivate`
 * errors if the item is already active there — those errors are tolerated so
 * the call is idempotent.
 */
async function activateInventoryAtLocation(
  creds: ShopifyCreds,
  variants: ShopifyVariantRow[],
  locationId: string,
) {
  let activated = 0;
  for (const v of variants) {
    const data = await gql<any>(
      creds,
      `mutation($inventoryItemId: ID!, $locationId: ID!) {
         inventoryActivate(inventoryItemId: $inventoryItemId, locationId: $locationId) {
           inventoryLevel { id }
           userErrors { field message }
         }
       }`,
      { inventoryItemId: v.inventoryItem.id, locationId },
    );
    const errs = (data?.inventoryActivate?.userErrors ?? []) as Array<{ message: string }>;
    const benign = errs.every((e) => /already.*activ/i.test(e.message));
    if (errs.length && !benign) {
      throw new Error(`inventoryActivate errors: ${errs.map((e) => e.message).join("; ")}`);
    }
    if (errs.length === 0) activated += 1;
  }
  return activated;
}

/**
 * Push absolute on-hand quantities to Shopify. `quantitiesByItemId` maps
 * inventoryItem GID → quantity. Skips items with a `null`/`undefined` qty.
 */
async function setOnHandQuantities(
  creds: ShopifyCreds,
  locationId: string,
  quantitiesByItemId: Map<string, number>,
) {
  const setQuantities = Array.from(quantitiesByItemId.entries())
    .filter(([, q]) => Number.isFinite(q))
    .map(([inventoryItemId, q]) => ({ inventoryItemId, locationId, quantity: Math.max(0, Math.floor(q)) }));
  if (setQuantities.length === 0) return 0;
  const data = await gql<any>(
    creds,
    `mutation($input: InventorySetOnHandQuantitiesInput!) {
       inventorySetOnHandQuantities(input: $input) {
         inventoryAdjustmentGroup { id }
         userErrors { field message }
       }
     }`,
    {
      input: {
        reason: "correction",
        referenceDocumentUri: "logistics://toastd-vendor-sync",
        setQuantities,
      },
    },
  );
  const errs = data?.inventorySetOnHandQuantities?.userErrors ?? [];
  if (errs.length) throw new Error(`inventorySetOnHandQuantities errors: ${errs.map((e: any) => e.message).join("; ")}`);
  return setQuantities.length;
}

/**
 * Build the alien-variant → quantity map keyed by Shopify inventoryItem.id.
 *
 * Inventory-sync safety rules (standard "don't go backwards" pattern):
 *   - Use max(alien_qty, merchant_mirror_qty) as the target. If alien is
 *     temporarily stale/zero we won't blow away a positive count that
 *     ShipTurtle already pushed.
 *   - Skip the entry entirely when the resolved target is 0 — Shopify will
 *     keep whatever it currently has, and ShipTurtle's regular stock sync
 *     remains the authority for legitimate decrements.
 *   - Match Shopify variants by their numeric ID (extracted from the GID),
 *     with a fallback by case-insensitive title for products whose
 *     `merchant_variants` haven't been populated yet.
 */
function buildAlienQuantityMap(
  shopifyVariants: ShopifyVariantRow[] & { title?: string }[],
  alienProduct: any,
): Map<string, number> {
  const out = new Map<string, number>();
  if (!alienProduct?.variants) return out;

  const byMerchantVarId = new Map<string, ShopifyVariantRow>();
  const byTitle = new Map<string, ShopifyVariantRow>();
  for (const sv of shopifyVariants) {
    const m = /\/ProductVariant\/(\d+)/.exec(sv.id);
    if (m) byMerchantVarId.set(m[1], sv);
    const t = (sv as any).title;
    if (typeof t === "string" && t.trim()) byTitle.set(t.trim().toLowerCase(), sv);
  }

  const toInt = (x: unknown) => {
    const n = Number(x);
    return Number.isFinite(n) ? Math.max(0, Math.floor(n)) : 0;
  };

  for (const av of alienProduct.variants) {
    const merchant = (av.merchant_variants ?? [])[0];
    let sv: ShopifyVariantRow | undefined;
    if (merchant?.id) sv = byMerchantVarId.get(String(merchant.id));
    if (!sv && typeof av.title === "string") sv = byTitle.get(av.title.trim().toLowerCase());
    if (!sv) continue;

    const target = Math.max(toInt(av.inventory_quantity), toInt(merchant?.inventory_quantity));
    if (target <= 0) continue; // never push 0 — preserve whatever Shopify has
    out.set(sv.inventoryItem.id, target);
  }
  return out;
}

/**
 * Make a synced product fully inventory-ready in Shopify:
 *   1. Flip `inventoryItem.tracked` → true (so quantities matter)
 *   2. Set `inventoryPolicy` → DENY (so Shopify won't oversell)
 *   3. Activate each variant at the primary location ("available at this location")
 *   4. Push absolute quantities from the ShipTurtle alien product (if provided)
 *
 * Every step is idempotent; safe to re-run on every sync.
 */
export async function enableInventoryTracking(
  creds: ShopifyCreds,
  productGid: string,
  alienProduct?: any,
) {
  const product = await getProduct(creds, productGid);
  const variants: ShopifyVariantRow[] = (product?.variants?.edges ?? []).map((e: any) => e.node);
  if (variants.length === 0) {
    return { variantsUpdated: 0, itemsUpdated: 0, activated: 0, quantitiesSet: 0 };
  }

  const itemsUpdated = await flipTrackingForVariants(creds, variants);
  const variantsUpdated = await denyOversellForVariants(creds, productGid, variants);

  const locationId = await getPrimaryLocationId(creds);
  const activated = await activateInventoryAtLocation(creds, variants, locationId);

  let quantitiesSet = 0;
  if (alienProduct) {
    const qmap = buildAlienQuantityMap(variants, alienProduct);
    quantitiesSet = await setOnHandQuantities(creds, locationId, qmap);
  }

  return { variantsUpdated, itemsUpdated, activated, quantitiesSet };
}
