import fs from "fs";
import path from "path";
import { initializeApp, getApps, cert, type App } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";

const configPath = path.join(process.cwd(), "firebase-applet-config.json");
const firebaseConfig = JSON.parse(fs.readFileSync(configPath, "utf-8"));

export const userProjectId = firebaseConfig.projectId as string;
export const userDatabaseId = firebaseConfig.firestoreDatabaseId as string | undefined;

process.env.GOOGLE_CLOUD_PROJECT = userProjectId;
process.env.FIRESTORE_PROJECT_ID = userProjectId;

/** Admin SDK needs a service account JSON on Vercel (no GCP metadata server). */
export function hasFirebaseAdminCredentials(): boolean {
  return Boolean(process.env.FIREBASE_SERVICE_ACCOUNT_JSON?.trim());
}

let appInstance: App;

if (getApps().length === 0) {
  const saJson = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  if (saJson) {
    appInstance = initializeApp({
      credential: cert(JSON.parse(saJson)),
      projectId: userProjectId,
    });
    console.log(`[Admin] Initialized with service account (project: ${userProjectId})`);
  } else {
    console.log(`[Admin] Initializing with Project ID: ${userProjectId}`);
    appInstance = initializeApp({
      projectId: userProjectId,
    });
  }
} else {
  appInstance = getApps()[0];
}

console.log(`[Admin] Effective Project ID: ${appInstance.options.projectId || "UNKNOWN"}`);

export const db =
  userDatabaseId !== undefined && userDatabaseId !== ""
    ? getFirestore(appInstance, userDatabaseId)
    : getFirestore(appInstance);

async function testConnection() {
  try {
    if (process.env.VERCEL === "1" && !hasFirebaseAdminCredentials()) {
      console.warn(
        "[Firestore] Skipping startup test: set FIREBASE_SERVICE_ACCOUNT_JSON on Vercel (Firestore admin calls will fail without it)."
      );
      return;
    }
    const dbId = userDatabaseId || "(default)";
    console.log(`[Firestore] Connection Test: Project=${userProjectId}, Database=${dbId}`);
    console.log("[Firestore] Attempting to read settings/app...");
    const settingsCheck = await db.collection("settings").doc("app").get();
    console.log(`[Firestore] Settings access: OK (Exists: ${settingsCheck.exists})`);
  } catch (error: unknown) {
    const err = error as { code?: string; message?: string };
    console.error(`[Firestore] Connection test FAILED`);
    console.error(`- Code: ${err.code}`);
    console.error(`- Message: ${err.message}`);
  }
}

testConnection().catch((err) => console.error("[Firestore] Startup test check failed:", err));
