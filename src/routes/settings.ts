import { Hono } from "hono";
import { Collections, SETTINGS_DOC } from "../firestore.js";
import type { Settings } from "../types.js";
import { z } from "zod";
import { searchApprovedVendors } from "../services/shipturtle.js";
import { refreshAndPersistShipTurtleToken } from "../services/shipturtle-auth.js";
import { whoAmI, normalizeShopDomain } from "../services/shopify.js";
import { listBrands, ToastdAuthError } from "../services/toastd.js";
import { log } from "../lib/log.js";

export const settingsRouter = new Hono();

const defaults: Settings = {
  shipturtleToken: "",
  shopifyStoreDomain: "",
  shopifyAdminToken: "",
  toastdAdminToken: "",
  globalSyncEnabled: false,
  syncIntervalMinutes: 30,
  toastdPublicationNameHint: "",
  shipturtleAutoRefreshEnabled: false,
  shipturtleUsername: "",
  shipturtlePassword: "",
  shipturtleClientId: "",
  shipturtleClientSecret: "",
  shipturtleRefreshToken: "",
};

function maskTail(v?: string | null, keep = 4) {
  if (!v) return "";
  if (v.length <= keep) return "••••";
  return `••••${v.slice(-keep)}`;
}

export async function getSettings(): Promise<Settings> {
  const snap = await Collections.settings.doc(SETTINGS_DOC).get();
  if (!snap.exists) return { ...defaults };
  return { ...defaults, ...(snap.data() as Settings) };
}

settingsRouter.get("/", async (c) => {
  const s = await getSettings();
  return c.json({
    ...s,
    shipturtleToken: maskTail(s.shipturtleToken),
    shopifyAdminToken: maskTail(s.shopifyAdminToken),
    toastdAdminToken: maskTail(s.toastdAdminToken),
    // OAuth credentials are masked but presence is reported so the UI can
    // show "currently set" without ever shipping the secret back to the browser.
    shipturtlePassword: maskTail(s.shipturtlePassword, 2),
    shipturtleClientSecret: maskTail(s.shipturtleClientSecret),
    shipturtleRefreshToken: maskTail(s.shipturtleRefreshToken),
    _hasShipturtleToken: !!s.shipturtleToken,
    _hasShopifyAdminToken: !!s.shopifyAdminToken,
    _hasToastdAdminToken: !!s.toastdAdminToken,
    _hasShipturtlePassword: !!s.shipturtlePassword,
    _hasShipturtleClientSecret: !!s.shipturtleClientSecret,
    _hasShipturtleRefreshToken: !!s.shipturtleRefreshToken,
  });
});

const PutBody = z.object({
  shipturtleToken: z.string().optional(),
  shopifyStoreDomain: z.string().optional(),
  shopifyAdminToken: z.string().optional(),
  toastdAdminToken: z.string().optional(),
  globalSyncEnabled: z.boolean().optional(),
  syncIntervalMinutes: z.number().int().min(5).max(1440).optional(),
  toastdPublicationNameHint: z.string().optional(),
  shipturtleAutoRefreshEnabled: z.boolean().optional(),
  shipturtleUsername: z.string().optional(),
  shipturtlePassword: z.string().optional(),
  shipturtleClientId: z.string().optional(),
  shipturtleClientSecret: z.string().optional(),
  shipturtleRefreshToken: z.string().optional(),
});

settingsRouter.put("/", async (c) => {
  const body = await c.req.json();
  const parsed = PutBody.safeParse(body);
  if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);
  const cur = await getSettings();
  const merged: Settings = { ...cur };
  for (const [k, v] of Object.entries(parsed.data)) {
    if (v === undefined) continue;
    (merged as any)[k] = v;
  }
  if (merged.shopifyStoreDomain) {
    merged.shopifyStoreDomain = normalizeShopDomain(merged.shopifyStoreDomain);
  }
  merged.updatedAt = Date.now();
  await Collections.settings.doc(SETTINGS_DOC).set(merged, { merge: true });
  return c.json({ ok: true });
});

settingsRouter.get("/auth-status", async (c) => {
  const s = await getSettings();
  const out: any = { shipturtle: { ok: false }, shopify: { ok: false }, toastd: { ok: false } };

  if (s.shipturtleToken) {
    try {
      const v = await searchApprovedVendors(s.shipturtleToken, { length: 1 });
      out.shipturtle = { ok: true, vendorCount: v.recordsTotal };
    } catch (e: any) {
      out.shipturtle = { ok: false, error: e.message };
    }
  } else {
    out.shipturtle = { ok: false, error: "no token" };
  }

  if (s.shopifyStoreDomain && s.shopifyAdminToken) {
    try {
      const shop = await whoAmI({ domain: s.shopifyStoreDomain, adminToken: s.shopifyAdminToken });
      out.shopify = { ok: !!shop?.id, shop };
    } catch (e: any) {
      out.shopify = { ok: false, error: e.message };
    }
  } else {
    out.shopify = { ok: false, error: "missing domain or token" };
  }

  if (s.toastdAdminToken) {
    try {
      const brands = await listBrands(s.toastdAdminToken);
      out.toastd = { ok: true, brandCount: brands.length };
    } catch (e: any) {
      const reason = e instanceof ToastdAuthError ? "auth invalid" : e.message;
      out.toastd = { ok: false, error: reason };
    }
  } else {
    out.toastd = { ok: false, error: "no token" };
  }

  return c.json(out);
});

/**
 * Manual ShipTurtle token refresh — runs the same OAuth call the auto-refresh
 * wrapper uses, but driven by a button in Settings so the user can verify
 * credentials before turning auto-refresh on.
 */
settingsRouter.post("/shipturtle/refresh", async (c) => {
  const s = await getSettings();
  if (!s.shipturtleClientId || !s.shipturtleClientSecret) {
    return c.json({ ok: false, error: "Set client_id and client_secret first" }, 400);
  }
  if (!s.shipturtleRefreshToken && (!s.shipturtleUsername || !s.shipturtlePassword)) {
    return c.json({ ok: false, error: "Need either a refresh_token or username + password" }, 400);
  }
  try {
    const tok = await refreshAndPersistShipTurtleToken({ ...s, shipturtleAutoRefreshEnabled: true });
    await log({ level: "success", message: "ShipTurtle token refreshed manually from Settings", step: "system" });
    return c.json({
      ok: true,
      expiresIn: tok.expires_in,
      tokenTail: tok.access_token.slice(-6),
    });
  } catch (e: any) {
    await log({ level: "error", message: `Manual ShipTurtle refresh failed: ${e.message}`, step: "system" });
    return c.json({ ok: false, error: e.message }, 500);
  }
});
