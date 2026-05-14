import { initializeApp, cert, getApps } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";

function initDb() {
  if (getApps().length === 0) {
    const inline = process.env.FIREBASE_SERVICE_ACCOUNT;
    initializeApp(
      inline ? { credential: cert(JSON.parse(inline)) } : undefined
    );
  }
  const databaseId = process.env.FIRESTORE_DATABASE_ID || "(default)";
  const firestore = getFirestore(getApps()[0]!, databaseId);
  firestore.settings({ ignoreUndefinedProperties: true });
  return firestore;
}

export const db = initDb();

export const Collections = {
  settings: db.collection("settings"),
  vendors: db.collection("vendors"),
  products: db.collection("products"),
  syncJobs: db.collection("sync_jobs"),
  eventLogs: db.collection("event_logs"),
} as const;

export const SETTINGS_DOC = "main";
