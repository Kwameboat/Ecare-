import { db } from "./firebase-init.js";

/**
 * API key resolution: Vercel/host `GEMINI_API_KEY` wins; else `settings/gemini` in Firestore (admin-written only).
 */
export async function getGeminiApiKey(): Promise<string | null> {
  const fromEnv = process.env.GEMINI_API_KEY?.trim();
  if (fromEnv) return fromEnv;

  try {
    const snap = await db.collection("settings").doc("gemini").get();
    const k = snap.data()?.apiKey;
    if (typeof k === "string" && k.trim().length > 0) return k.trim();
  } catch (e) {
    console.error("[Gemini] Could not read settings/gemini:", e);
  }
  return null;
}
