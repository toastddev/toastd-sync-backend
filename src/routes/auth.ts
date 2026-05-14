import { Hono } from "hono";
import { signToken } from "../auth.js";
import { z } from "zod";

export const authRouter = new Hono();

authRouter.post("/login", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const parsed = z.object({ password: z.string() }).safeParse(body);
  if (!parsed.success) return c.json({ error: "invalid" }, 400);
  const expected = process.env.DASHBOARD_PASSWORD || "";
  if (!expected) return c.json({ error: "server_misconfigured" }, 500);
  if (parsed.data.password !== expected) return c.json({ error: "wrong_password" }, 401);
  return c.json({ token: signToken() });
});
