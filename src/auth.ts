import { createMiddleware } from "hono/factory";
import jwt from "jsonwebtoken";

const SECRET = () => process.env.JWT_SECRET || "dev-secret-change-me";

export function signToken(): string {
  return jwt.sign({ role: "admin" }, SECRET(), { expiresIn: "30d" });
}

export function verifyToken(tok: string): boolean {
  try {
    jwt.verify(tok, SECRET());
    return true;
  } catch {
    return false;
  }
}

export const requireAuth = createMiddleware(async (c, next) => {
  const auth = c.req.header("authorization") || "";
  let tok = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  // EventSource can't set headers — allow ?token= as a fallback (SSE endpoints).
  if (!tok) tok = c.req.query("token") || "";
  if (!tok || !verifyToken(tok)) {
    return c.json({ error: "unauthorized" }, 401);
  }
  await next();
});
