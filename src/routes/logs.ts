import { Hono } from "hono";
import { listLogs, logBus } from "../lib/log.js";
import { streamSSE } from "hono/streaming";

export const logsRouter = new Hono();

logsRouter.get("/", async (c) => {
  const limit = Number(c.req.query("limit") ?? 200);
  const vendorId = c.req.query("vendorId") || undefined;
  const level = (c.req.query("level") as any) || undefined;
  const logs = await listLogs({ limit, vendorId, level });
  return c.json(logs);
});

logsRouter.get("/stream", (c) => {
  return streamSSE(c, async (stream) => {
    const handler = (e: any) => {
      stream.writeSSE({ event: "log", data: JSON.stringify(e) }).catch(() => {});
    };
    logBus.on("log", handler);
    const ping = setInterval(() => {
      stream.writeSSE({ event: "ping", data: String(Date.now()) }).catch(() => {});
    }, 15000);
    await stream.writeSSE({ event: "ready", data: "1" });
    await new Promise<void>((resolve) => {
      stream.onAbort(() => {
        clearInterval(ping);
        logBus.off("log", handler);
        resolve();
      });
    });
  });
});
