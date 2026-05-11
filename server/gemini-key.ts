import { db, hasFirebaseAdminCredentials } from "./firebase-init.js";

/**
 * API key resolution: Vercel/host `GEMINI_API_KEY` wins; else `settings/gemini` in Firestore (admin-written only).
 */
function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timeout (${ms}ms)`)), ms);
    promise
      .then((v) => {
        clearTimeout(timer);
        resolve(v);
      })
      .catch((e) => {
        clearTimeout(timer);
        reject(e);
      });
  });
}

export async function getGeminiApiKey(): Promise<string | null> {
  const fromEnv = process.env.GEMINI_API_KEY?.trim();
  if (fromEnv) return fromEnv;

  // In Vercel production, prefer env var only unless explicitly allowed.
  if (
    process.env.VERCEL === "1" &&
    process.env.ALLOW_FIRESTORE_GEMINI_KEY_FALLBACK !== "1"
  ) {
    return null;
  }

  if (!hasFirebaseAdminCredentials()) {
    return null;
  }

  try {
    const snap = await withTimeout(
      db.collection("settings").doc("gemini").get(),
      4_000,
      "gemini_key_firestore_read"
    );
    const k = snap.data()?.apiKey;
    if (typeof k === "string" && k.trim().length > 0) return k.trim();
  } catch (e) {
    console.error("[Gemini] Could not read settings/gemini:", e);
  }
  return null;
}
