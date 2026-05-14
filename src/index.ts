import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { authRouter } from "./routes/auth.js";
import { settingsRouter } from "./routes/settings.js";
import { brandsRouter } from "./routes/brands.js";
import { vendorsRouter } from "./routes/vendors.js";
import { syncRouter } from "./routes/sync.js";
import { productsRouter } from "./routes/products.js";
import { logsRouter } from "./routes/logs.js";
import { requireAuth } from "./auth.js";
import { startScheduler } from "./workers/scheduler.js";
import { log, startLogPruner } from "./lib/log.js";
import { recoverInFlightProducts } from "./services/recovery.js";

const app = new Hono();

// CORS — in dev (no ALLOWED_ORIGINS) we echo whichever origin called us.
// In prod, the env var holds a comma-separated allowlist (e.g. the admin
// Firebase Hosting domain that embeds /sync).
const allowedOrigins = (process.env.ALLOWED_ORIGINS ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

app.use(
  "/*",
  cors({
    origin: (o) => {
      if (!o) return "*";
      if (allowedOrigins.length === 0) return o; // dev / any
      return allowedOrigins.includes(o) ? o : null;
    },
    credentials: true,
    allowHeaders: ["Authorization", "Content-Type"],
  }),
);

app.get("/health", (c) => c.json({ ok: true, ts: Date.now() }));

app.route("/api/auth", authRouter);

const api = new Hono();
api.use("*", requireAuth);
api.route("/settings", settingsRouter);
api.route("/brands", brandsRouter);
api.route("/vendors", vendorsRouter);
api.route("/sync", syncRouter);
api.route("/products", productsRouter);
api.route("/logs", logsRouter);
app.route("/api", api);

app.notFound((c) => c.json({ error: "not_found" }, 404));
app.onError((err, c) => {
  console.error(err);
  return c.json({ error: err.message ?? "internal" }, 500);
});

const port = Number(process.env.PORT || 8787);
serve({ fetch: app.fetch, port }, ({ port }) => {
  // eslint-disable-next-line no-console
  console.log(`[backend] listening on http://localhost:${port}`);
  log({ level: "info", message: `Backend started on :${port}`, step: "system" }).catch(() => {});
  startScheduler();
  startLogPruner();
  // Recover any products left in "running" from a previous crash. Cleans
  // partial Shopify/Toastd resources and resets state so the next sync run
  // re-creates them from step 1.
  recoverInFlightProducts().catch((e) =>
    log({ level: "error", message: `Recovery sweep failed: ${e.message}`, step: "system" }).catch(() => {}),
  );
});
