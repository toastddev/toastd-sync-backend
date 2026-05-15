export interface Settings {
  shipturtleToken: string;
  shopifyStoreDomain: string; // e.g. toastd-merchant.myshopify.com
  shopifyAdminToken: string;
  /** Sent as `x-toastd-access-token` header on every api.toastd.in request. */
  toastdAdminToken: string;
  globalSyncEnabled: boolean;
  syncIntervalMinutes: number;
  // Optional override hint for the Toastd inventory publication name; if empty we auto-detect.
  toastdPublicationNameHint?: string;
  // ── ShipTurtle auto-refresh (OAuth password / refresh-token grant) ─────────
  /** When true, expired ShipTurtle tokens are refreshed automatically and the original request retried. */
  shipturtleAutoRefreshEnabled?: boolean;
  shipturtleUsername?: string;
  shipturtlePassword?: string;
  shipturtleClientId?: string;
  shipturtleClientSecret?: string;
  /** Long-lived refresh token returned by ShipTurtle's oauth/token endpoint. */
  shipturtleRefreshToken?: string;
  shipturtleTokenExpiresAt?: number;
  shipturtleTokenRefreshedAt?: number;
  updatedAt?: number;
}

export interface VendorRecord {
  id: string; // vendor_shop_id as string
  vendorShopId: number;
  parentVendorId?: number | null;
  title: string;
  companyName?: string | null;
  email?: string | null;
  domain?: string | null; // myshopify.com domain of the vendor's own store
  vendorType?: string | null;
  syncEnabled: boolean;
  brandId?: string | null; // toastd brand id
  brandName?: string | null;
  lastSyncAt?: number | null;
  lastSyncStatus?: "ok" | "error" | "running" | null;
  lastError?: string | null;
  totalProducts?: number;
  mappedProducts?: number;
  isFrozen?: boolean;
  raw?: unknown;
  updatedAt?: number;
}

export interface ProductRecord {
  id: string; // composite: `${vendorShopId}_${alienProductId}`
  vendorShopId: number;
  alienProductId: number; // shipturtle product id (vendor side)
  title: string;
  handle?: string | null;
  vendorDomain?: string | null;
  productType?: string | null;
  status?: string | null;
  image?: string | null;
  mappingStatus?: "FULLY_MAPPED" | "PARTIALLY_MAPPED" | "UNMAPPED";
  // Step1 results
  step1?: {
    completedAt?: number;
    merchantProductId?: number; // shipturtle merchant product id
    shopifyProductGid?: string; // gid://shopify/Product/...
    error?: string | null;
  };
  step2?: {
    completedAt?: number;
    publishedToOnlineStore?: boolean;
    publishedToToastd?: boolean;
    error?: string | null;
  };
  step3?: {
    completedAt?: number;
    toastdProductId?: string;
    imagesUploaded?: number;
    imagesFailed?: number;
    error?: string | null;
    // True when step3 didn't actually create the Toastd product — the
    // backend reported the slug already existed and we mapped to the
    // pre-existing record. Distinguishes "we created this" from "this
    // was already in Toastd before we synced".
    fromExisting?: boolean;
  };
  pipelineStatus?:
    | "pending"
    | "running"
    | "done"
    | "error"
    | "skipped_existing"
    | "rolled_back"
    | "website_product_missing";
  lastError?: string | null;
  retryCount?: number;
  updatedAt?: number;
  raw?: unknown;
}

export interface SyncJobRecord {
  id: string;
  startedAt: number;
  finishedAt?: number;
  trigger: "cron" | "manual_vendor" | "manual_product";
  vendorShopId?: number | null;
  alienProductId?: number | null;
  status: "running" | "done" | "error";
  totalProducts?: number;
  processed?: number;
  succeeded?: number;
  failed?: number;
  currentProductTitle?: string | null;
  currentBrandName?: string | null;
  error?: string | null;
}
