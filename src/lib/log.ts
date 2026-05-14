import { Collections } from "../firestore.js";
import { EventEmitter } from "node:events";

export type LogLevel = "info" | "warn" | "error" | "success";

export interface LogEntry {
  ts: number;
  level: LogLevel;
  message: string;
  vendorId?: string | null;
  vendorName?: string | null;
  productId?: string | null;
  productTitle?: string | null;
  step?: "step1" | "step2" | "step3a" | "step3b" | "step3c" | "system";
  meta?: Record<string, unknown>;
}

export const logBus = new EventEmitter();
logBus.setMaxListeners(50);

/**
 * Levels persisted to Firestore. `info` is intentionally omitted: the SSE
 * stream still receives it (for the live-tail UI) and stdout still prints it,
 * but persisting every "step starting" line would multiply writes by ~5x for
 * no operator value. Drop a `LOG_PERSIST_INFO=1` env var to opt back in.
 */
const PERSIST_LEVELS: ReadonlySet<LogLevel> =
  process.env.LOG_PERSIST_INFO === "1"
    ? new Set<LogLevel>(["info", "warn", "error", "success"])
    : new Set<LogLevel>(["warn", "error", "success"]);

/** Retention: prune logs older than this on a slow timer. */
const RETENTION_MS = Number(process.env.LOG_RETENTION_MS || 14 * 24 * 60 * 60 * 1000); // 14 days
const PRUNE_INTERVAL_MS = Number(process.env.LOG_PRUNE_INTERVAL_MS || 6 * 60 * 60 * 1000); // every 6 h

/**
 * Batched writer. Logs queued up here are flushed to Firestore in a single
 * batched commit every FLUSH_INTERVAL_MS, or eagerly when the buffer hits
 * MAX_BUFFER. This collapses N writes → ⌈N/MAX_BUFFER⌉ writes and amortises
 * the Firestore round-trip cost.
 */
const FLUSH_INTERVAL_MS = 2_500;
const MAX_BUFFER = 250; // Firestore batch limit is 500; leave headroom
let queue: LogEntry[] = [];
let flushTimer: NodeJS.Timeout | null = null;
let flushing = false;

async function flush(): Promise<void> {
  if (flushing) return;
  if (queue.length === 0) {
    if (flushTimer) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
    return;
  }
  flushing = true;
  const batchEntries = queue.splice(0, MAX_BUFFER);
  try {
    const batch = Collections.eventLogs.firestore.batch();
    for (const entry of batchEntries) {
      batch.set(Collections.eventLogs.doc(), entry);
    }
    await batch.commit();
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error("failed to persist log batch", e);
    // On a transient failure, push the entries back so they aren't lost.
    queue.unshift(...batchEntries);
  } finally {
    flushing = false;
  }
  // If more accumulated while flushing, drain in a tail call.
  if (queue.length > 0) {
    if (flushTimer) clearTimeout(flushTimer);
    flushTimer = setTimeout(() => void flush(), 0);
  } else if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
}

function scheduleFlush() {
  if (flushTimer || flushing) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    void flush();
  }, FLUSH_INTERVAL_MS);
}

// Drain the queue on shutdown so we don't lose buffered logs. Cloud Run sends
// SIGTERM and gives ~10s before SIGKILL — block on the flush so it actually
// completes instead of getting dropped.
async function shutdown() {
  try {
    await flush();
  } catch {}
}
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
process.once("beforeExit", shutdown);

/**
 * Background pruner — keeps the event_logs collection bounded so reads stay
 * cheap and storage doesn't grow unbounded. Runs on an interval, deleting in
 * batches of up to 400 (Firestore batch cap = 500, leave headroom).
 */
async function pruneOldLogs() {
  try {
    const cutoff = Date.now() - RETENTION_MS;
    while (true) {
      const snap = await Collections.eventLogs
        .where("ts", "<", cutoff)
        .orderBy("ts", "asc")
        .limit(400)
        .get();
      if (snap.empty) break;
      const batch = Collections.eventLogs.firestore.batch();
      snap.docs.forEach((d) => batch.delete(d.ref));
      await batch.commit();
      if (snap.size < 400) break; // last page
    }
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error("log pruner failed (will retry next tick):", e);
  }
}

let prunerStarted = false;
export function startLogPruner() {
  if (prunerStarted) return;
  prunerStarted = true;
  // Stagger the first run by a minute so dev restarts don't dogpile.
  setTimeout(() => void pruneOldLogs(), 60_000);
  setInterval(() => void pruneOldLogs(), PRUNE_INTERVAL_MS).unref?.();
}

export async function log(entry: Omit<LogEntry, "ts"> & { ts?: number }) {
  const full: LogEntry = { ts: entry.ts ?? Date.now(), ...entry };
  // eslint-disable-next-line no-console
  console.log(`[${full.level}]`, full.message, full.meta ?? "");
  logBus.emit("log", full);
  if (!PERSIST_LEVELS.has(full.level)) return;
  queue.push(full);
  if (queue.length >= MAX_BUFFER) {
    void flush();
  } else {
    scheduleFlush();
  }
}

export async function listLogs(opts: { limit?: number; vendorId?: string; level?: LogLevel } = {}) {
  let q: FirebaseFirestore.Query = Collections.eventLogs.orderBy("ts", "desc");
  if (opts.vendorId) q = q.where("vendorId", "==", opts.vendorId);
  if (opts.level) q = q.where("level", "==", opts.level);
  q = q.limit(Math.min(opts.limit ?? 200, 1000));
  const snap = await q.get();
  return snap.docs.map((d) => ({ id: d.id, ...(d.data() as LogEntry) }));
}
