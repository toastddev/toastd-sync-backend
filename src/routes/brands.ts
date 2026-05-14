import { Hono } from "hono";
import { listBrands } from "../services/toastd.js";
import { getSettings } from "./settings.js";

export const brandsRouter = new Hono();

let cache: { ts: number; data: any[] } | null = null;
const TTL = 5 * 60 * 1000;

brandsRouter.get("/", async (c) => {
  if (cache && Date.now() - cache.ts < TTL) return c.json(cache.data);
  const s = await getSettings();
  const data = await listBrands(s.toastdAdminToken);
  cache = { ts: Date.now(), data };
  return c.json(data);
});

brandsRouter.post("/refresh", async (c) => {
  const s = await getSettings();
  const data = await listBrands(s.toastdAdminToken);
  cache = { ts: Date.now(), data };
  return c.json({ count: data.length });
});
