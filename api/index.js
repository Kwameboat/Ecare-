// scripts/vercel-api-entry.ts
import "dotenv/config";
import serverless from "serverless-http";

// server/app.ts
import express from "express";
import path2 from "path";
import { createServer as createViteServer } from "vite";
import cors from "cors";
import { FieldValue as FieldValue2 } from "firebase-admin/firestore";

// server/firebase-init.ts
import fs from "fs";
import path from "path";
import { initializeApp, getApps, cert } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
var configPath = path.join(process.cwd(), "firebase-applet-config.json");
var firebaseConfig = JSON.parse(fs.readFileSync(configPath, "utf-8"));
var userProjectId = firebaseConfig.projectId;
var userDatabaseId = firebaseConfig.firestoreDatabaseId;
process.env.GOOGLE_CLOUD_PROJECT = userProjectId;
process.env.FIRESTORE_PROJECT_ID = userProjectId;
var appInstance;
if (getApps().length === 0) {
  const saJson = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  if (saJson) {
    appInstance = initializeApp({
      credential: cert(JSON.parse(saJson)),
      projectId: userProjectId
    });
    console.log(`[Admin] Initialized with service account (project: ${userProjectId})`);
  } else {
    console.log(`[Admin] Initializing with Project ID: ${userProjectId}`);
    appInstance = initializeApp({
      projectId: userProjectId
    });
  }
} else {
  appInstance = getApps()[0];
}
console.log(`[Admin] Effective Project ID: ${appInstance.options.projectId || "UNKNOWN"}`);
var db = userDatabaseId !== void 0 && userDatabaseId !== "" ? getFirestore(appInstance, userDatabaseId) : getFirestore(appInstance);
async function testConnection() {
  try {
    const dbId = userDatabaseId || "(default)";
    console.log(`[Firestore] Connection Test: Project=${userProjectId}, Database=${dbId}`);
    console.log("[Firestore] Attempting to read settings/app...");
    const settingsCheck = await db.collection("settings").doc("app").get();
    console.log(`[Firestore] Settings access: OK (Exists: ${settingsCheck.exists})`);
  } catch (error) {
    const err = error;
    console.error(`[Firestore] Connection test FAILED`);
    console.error(`- Code: ${err.code}`);
    console.error(`- Message: ${err.message}`);
  }
}
testConnection().catch((err) => console.error("[Firestore] Startup test check failed:", err));

// server/reminders.ts
import { FieldValue } from "firebase-admin/firestore";
async function runAppointmentReminders(db2) {
  console.log("[Reminder Job] Checking for upcoming appointments...");
  const now = Date.now();
  const targetTime = now + 24 * 60 * 60 * 1e3;
  const windowStart = targetTime - 15 * 60 * 1e3;
  const snapshot = await db2.collection("appointments").where("status", "==", "confirmed").get();
  console.log(`[Reminder Job] Found ${snapshot.size} confirmed appointments to screen.`);
  for (const doc of snapshot.docs) {
    const appt = doc.data();
    if (appt.reminded) continue;
    const apptDate = new Date(appt.dateTime).getTime();
    if (apptDate >= windowStart && apptDate <= targetTime) {
      console.log(`[Reminder Job] Sending reminder for appt: ${doc.id}`);
      const timeStr = new Date(appt.dateTime).toLocaleTimeString([], {
        hour: "2-digit",
        minute: "2-digit"
      });
      await db2.collection("notifications").add({
        userId: appt.userId,
        title: "Appointment Reminder",
        message: `Friendly reminder: Your session with Dr. ${appt.doctorName} is scheduled for tomorrow at ${timeStr}.`,
        type: "reminder",
        isRead: false,
        createdAt: FieldValue.serverTimestamp()
      });
      await db2.collection("notifications").add({
        userId: appt.doctorId,
        title: "Consultation Reminder",
        message: `Upcoming consultation with ${appt.patientName} tomorrow at ${timeStr}.`,
        type: "reminder",
        isRead: false,
        createdAt: FieldValue.serverTimestamp()
      });
      await doc.ref.update({
        reminded: true,
        updatedAt: FieldValue.serverTimestamp()
      });
    }
  }
}

// server/gemini-routes.ts
import { GoogleGenAI, Modality } from "@google/genai";

// server/gemini-key.ts
async function getGeminiApiKey() {
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

// server/gemini-routes.ts
var CHAT_MODEL = process.env.GEMINI_CHAT_MODEL?.trim() || "gemini-2.0-flash";
var SPEECH_MODEL = process.env.GEMINI_SPEECH_MODEL?.trim() || "gemini-2.5-flash-tts";
function normalizeChatContents(history, prompt, mediaParts) {
  const out = [];
  for (const h of history || []) {
    if (!h || typeof h !== "object") continue;
    const o = h;
    if (o.role !== "user" && o.role !== "model") continue;
    if (!Array.isArray(o.parts) || o.parts.length === 0) continue;
    out.push({ role: o.role, parts: o.parts });
  }
  const media = Array.isArray(mediaParts) ? mediaParts : [];
  const userParts = [{ text: prompt || "User sent audio/image" }, ...media];
  out.push({ role: "user", parts: userParts });
  return out;
}
function buildSystemInstruction(doctors) {
  const doctorsList = doctors.map((d) => `${d.name} (${d.specialty})`).join(", ");
  return `
    Act as a professional medical assistant for the African market, specifically Ghana.
    You are helpful, empathetic, and professional.

    TELEMEDICINE & DOCTORS:
    - You can recommend video consultations with professional doctors.
    - Available doctors: ${doctorsList || "General Practitioners available for booking"}.
    - DO NOT recommend a specific doctor immediately.
    - If you detect that the user needs professional help, ask: "Would you like me to match you with a specialist for a video consultation to discuss this further?"
    - ONLY if the patient agrees, identify the most relevant specialist based on the symptoms described (e.g., if it's a skin issue, match with a specialist who handles Dermatology/Skin).
    - Once they agree, mention that specific doctor's name clearly in your response (e.g., "Based on your symptoms, I recommend booking a session with Dr. [Name], who is our specialist in [Specialty]. They can help you with...") to trigger the booking UI.
    
    CONVERSATIONAL FLOW:
    - Your goal is to conduct a supportive and efficient "diagnostic interview".
    - ASK ONE QUESTION AT A TIME. 
    - DO NOT EXCEED 3-4 QUESTIONS before providing actionable health recommendations or next steps.
    - If you have gathered enough symptoms or context from the user's initial message or images, switch to providing recommendations immediately.
    - Validate their feelings briefly (e.g., "I understand that must be uncomfortable...") then provide the recommendation or the single most important follow-up question.

    RECOMMENDATIONS:
    - When you have sufficient information, provide clear, actionable health paths (e.g., home care, over-the-counter advice for minor issues, or a strong recommendation to see a specific specialist).
    - Always maintain a professional and safe tone.

    LANGUAGE SUPPORT:
    - Detect and respond in Twi, Ga, or English based on how the user communicates.
    - If the user speaks Twi, respond in Twi. If Ga, respond in Ga. If English, respond in English.
    - Your responses should be formatted for easy text-to-speech reading.
    
    PERSONA:
    - You are a "Health AI" dedicated to improving healthcare access. 
    - Provide clear, actionable health information.
    
    IMPORTANT DISCLAIMER:
    - Always include a disclaimer at the end or naturally in the flow that you are an AI and not a substitute for a human doctor.
    
    VISION & AUDIO:
    - You can analyze medical images and listen to voice complaints. 
    - Explain findings simply and ask follow-up questions to understand the context.
  `;
}
function attachGeminiRoutes(app) {
  app.get("/api/gemini/status", async (_req, res) => {
    try {
      const fromEnv = Boolean(process.env.GEMINI_API_KEY?.trim());
      let fromFirestore = false;
      if (!fromEnv) {
        const snap = await db.collection("settings").doc("gemini").get();
        const k = snap.data()?.apiKey;
        fromFirestore = typeof k === "string" && k.trim().length > 0;
      }
      const configured = fromEnv || fromFirestore;
      const source = fromEnv ? "environment" : fromFirestore ? "firestore" : "none";
      res.json({ ok: true, configured, source });
    } catch (e) {
      console.error("[Gemini status]", e);
      res.status(500).json({
        ok: false,
        configured: false,
        source: "none",
        error: e instanceof Error ? e.message : "status failed"
      });
    }
  });
  app.post("/api/gemini/chat", async (req, res) => {
    const apiKey = await getGeminiApiKey();
    if (!apiKey) {
      return res.status(503).json({
        error: "No Gemini API key: set GEMINI_API_KEY (Vercel) or save a key below in Admin \u2192 API Settings (Firestore)."
      });
    }
    try {
      const { prompt, history, mediaParts, doctors } = req.body;
      const ai = new GoogleGenAI({ apiKey });
      const systemInstruction = buildSystemInstruction(doctors || []);
      const contents = normalizeChatContents(history || [], prompt || "", mediaParts || []);
      const response = await ai.models.generateContent({
        model: CHAT_MODEL,
        contents,
        config: {
          systemInstruction
        }
      });
      const text = response.text ?? "";
      res.json({ text });
    } catch (e) {
      console.error("[Gemini chat]", e);
      const msg = e instanceof Error ? e.message : "Gemini request failed";
      res.status(500).json({ error: msg });
    }
  });
  app.post("/api/gemini/speech", async (req, res) => {
    const apiKey = await getGeminiApiKey();
    if (!apiKey) {
      return res.status(503).json({
        error: "No Gemini API key: set GEMINI_API_KEY (Vercel) or save a key below in Admin \u2192 API Settings (Firestore)."
      });
    }
    try {
      const { text } = req.body;
      if (!text?.trim()) {
        return res.status(400).json({ error: "text required" });
      }
      const ai = new GoogleGenAI({ apiKey });
      const response = await ai.models.generateContent({
        model: SPEECH_MODEL,
        contents: [{ role: "user", parts: [{ text: text.trim() }] }],
        config: {
          responseModalities: [Modality.AUDIO]
        }
      });
      const audioBase64 = response.data ?? null;
      res.json({ audioBase64 });
    } catch (e) {
      console.error("[Gemini speech]", e);
      const msg = e instanceof Error ? e.message : "Gemini speech failed";
      res.status(500).json({ error: msg });
    }
  });
}

// server/app.ts
async function createHttpApp() {
  const app = express();
  app.use(cors());
  app.use(express.json({ limit: "50mb" }));
  attachGeminiRoutes(app);
  app.get("/manifest.json", async (req, res) => {
    try {
      const settingsSnap = await db.collection("settings").doc("app").get();
      const settings = settingsSnap.exists ? settingsSnap.data() : {};
      const logoUrl = settings?.logoUrl || "https://cdn-icons-png.flaticon.com/512/2869/2869382.png";
      const appName = settings?.appName || "eCare GH AI";
      const tagline = settings?.tagline || "Your Intelligent Healthcare Companion";
      res.json({
        name: appName,
        short_name: appName.split(" ")[0],
        description: tagline,
        start_url: "/",
        display: "standalone",
        background_color: "#020203",
        theme_color: "#2563eb",
        icons: [
          {
            src: logoUrl,
            sizes: "192x192",
            type: logoUrl.includes(".svg") ? "image/svg+xml" : "image/png"
          },
          {
            src: logoUrl,
            sizes: "512x512",
            type: logoUrl.includes(".svg") ? "image/svg+xml" : "image/png"
          }
        ]
      });
    } catch (error) {
      console.error("Manifest generation error:", error);
      res.sendFile(path2.resolve("public/manifest.json"));
    }
  });
  app.post("/api/deduct-credits", async (req, res) => {
    const { userId, type } = req.body;
    if (!userId)
      return res.status(400).json({ success: false, error: "userId is required" });
    const settingsSnap = await db.collection("settings").doc("app").get();
    const settings = settingsSnap.exists ? settingsSnap.data() : {};
    const costs = settings?.creditCosts || {
      textPrompt: 1,
      imageGen: 5,
      voicePrompt: 2
    };
    let points = costs.textPrompt;
    if (type === "voice") points = costs.voicePrompt;
    if (type === "image" || type === "mixed" || type === "recommendation")
      points = costs.imageGen;
    try {
      console.log(`[Deduct Credits] userId: ${userId}, type: ${type}`);
      const userRef = db.collection("users").doc(userId);
      await db.runTransaction(async (transaction) => {
        const userDoc = await transaction.get(userRef);
        if (!userDoc.exists) throw new Error("User not found");
        const balance = userDoc.data()?.creditBalance ?? 0;
        if (balance < points) throw new Error("Insufficient credits");
        transaction.update(userRef, {
          creditBalance: balance - points,
          updatedAt: FieldValue2.serverTimestamp()
        });
      });
      res.json({ success: true });
    } catch (e) {
      console.error("[Deduct Credits]", e);
      const msg = e instanceof Error ? e.message : "Deduction failed";
      res.status(400).json({ success: false, error: msg });
    }
  });
  app.post("/api/verify-payment", async (req, res) => {
    try {
      const { reference } = req.body;
      if (!reference?.trim()) {
        return res.status(400).json({ success: false, error: "reference required" });
      }
      const secretSnap = await db.collection("settings").doc("paystack").get();
      const secretKey = secretSnap.data()?.secretKey;
      if (!secretKey?.trim()) {
        return res.status(500).json({
          success: false,
          error: "Paystack secret not configured (settings/paystack)"
        });
      }
      const verifyRes = await fetch(
        `https://api.paystack.co/transaction/verify/${encodeURIComponent(reference.trim())}`,
        { headers: { Authorization: `Bearer ${secretKey.trim()}` } }
      );
      const verifyJson = await verifyRes.json();
      if (!verifyJson.status || verifyJson.data?.status !== "success") {
        return res.json({
          success: false,
          error: verifyJson.message || "Verification failed"
        });
      }
      const meta = verifyJson.data?.metadata || {};
      const userId = meta.userId;
      const credits = meta.credits != null ? Number(meta.credits) : NaN;
      if (userId && Number.isFinite(credits) && credits > 0) {
        const userRef = db.collection("users").doc(userId);
        await db.runTransaction(async (tx) => {
          const snap = await tx.get(userRef);
          if (!snap.exists) throw new Error("User not found for credit grant");
          const balance = snap.data()?.creditBalance ?? 0;
          tx.update(userRef, {
            creditBalance: balance + credits,
            updatedAt: FieldValue2.serverTimestamp()
          });
          const txRef = userRef.collection("transactions").doc();
          tx.set(txRef, {
            type: "credit_purchase",
            credits,
            reference: reference.trim(),
            packageId: meta.packageId || null,
            createdAt: FieldValue2.serverTimestamp()
          });
        });
      }
      return res.json({ success: true });
    } catch (e) {
      console.error("[Verify Payment]", e);
      const msg = e instanceof Error ? e.message : "Verification error";
      return res.status(500).json({ success: false, error: msg });
    }
  });
  app.get("/api/cron/reminders", async (_req, res) => {
    try {
      await runAppointmentReminders(db);
      res.json({ ok: true });
    } catch (e) {
      console.error("[Cron reminders]", e);
      res.status(500).json({ ok: false });
    }
  });
  const onVercel = process.env.VERCEL === "1";
  const isProd = process.env.NODE_ENV === "production";
  if (isProd && onVercel) {
    const distDir = path2.join(process.cwd(), "dist");
    app.use(express.static(distDir));
    app.get("*", (req, res, next) => {
      if (req.path.startsWith("/api")) return next();
      res.sendFile(path2.join(distDir, "index.html"), (err) => {
        if (err) next(err);
      });
    });
    app.use((req, res) => {
      if (req.path.startsWith("/api")) {
        return res.status(404).json({ error: "Not found" });
      }
      res.status(404).send("Not found");
    });
  } else if (!onVercel) {
    const vite = await createViteServer({
      root: process.cwd(),
      server: { middlewareMode: true },
      appType: "spa"
    });
    app.use(vite.middlewares);
  }
  return app;
}

// scripts/vercel-api-entry.ts
var handlerPromise = (async () => {
  const app = await createHttpApp();
  return serverless(app);
})();
async function handler(req, res) {
  const handle = await handlerPromise;
  return handle(req, res);
}
export {
  handler as default
};
