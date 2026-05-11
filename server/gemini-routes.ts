import type { Express } from "express";
import { GoogleGenAI, Modality } from "@google/genai";
import { db, hasFirebaseAdminCredentials } from "./firebase-init.js";
import { getGeminiApiKey } from "./gemini-key.js";

/** Defaults use widely available AI Studio models; override via Vercel env if needed. */
const CHAT_MODEL = process.env.GEMINI_CHAT_MODEL?.trim() || "gemini-2.0-flash";
const SPEECH_MODEL = process.env.GEMINI_SPEECH_MODEL?.trim() || "gemini-2.5-flash-tts";
const SPEECH_TIMEOUT_MS = Math.min(
  Number(process.env.GEMINI_SPEECH_TIMEOUT_MS) || 25_000,
  120_000
);
const REST_CHAT_TIMEOUT_MS = Math.min(
  Number(process.env.GEMINI_CHAT_REST_TIMEOUT_MS) || 25_000,
  120_000
);

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

type GeminiGenerateContentResponse = {
  candidates?: Array<{
    content?: {
      parts?: Array<{ text?: string }>;
    };
  }>;
  error?: { message?: string };
};

async function generateChatViaRest(
  apiKey: string,
  systemInstruction: string,
  contents: object[]
): Promise<string> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), REST_CHAT_TIMEOUT_MS);
  try {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
      CHAT_MODEL
    )}:generateContent?key=${encodeURIComponent(apiKey)}`;

    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: ctrl.signal,
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: systemInstruction }] },
        contents,
      }),
    });

    const data = (await res.json().catch(() => ({}))) as GeminiGenerateContentResponse;
    if (!res.ok) {
      throw new Error(data.error?.message || `Gemini REST failed (${res.status})`);
    }

    const text =
      data.candidates?.[0]?.content?.parts
        ?.map((p) => p.text || "")
        .join("")
        .trim() || "";

    if (!text) {
      throw new Error("Gemini returned an empty response.");
    }
    return text;
  } catch (e: unknown) {
    if (e instanceof Error && e.name === "AbortError") {
      throw new Error(`gemini_chat timeout (${REST_CHAT_TIMEOUT_MS}ms)`);
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

function normalizeChatContents(
  history: unknown[],
  prompt: string,
  mediaParts: unknown[]
): object[] {
  const out: object[] = [];
  for (const h of history || []) {
    if (!h || typeof h !== "object") continue;
    const o = h as Record<string, unknown>;
    if (o.role !== "user" && o.role !== "model") continue;
    if (!Array.isArray(o.parts) || o.parts.length === 0) continue;
    out.push({ role: o.role, parts: o.parts });
  }
  const media = Array.isArray(mediaParts) ? (mediaParts as object[]) : [];
  const userParts: object[] = [{ text: prompt || "User sent audio/image" }, ...media];
  out.push({ role: "user", parts: userParts });
  return out;
}

function buildSystemInstruction(doctors: { name: string; specialty: string }[]) {
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

export function attachGeminiRoutes(app: Express) {
  app.get("/api/gemini/status", async (_req, res) => {
    try {
      const fromEnv = Boolean(process.env.GEMINI_API_KEY?.trim());
      let fromFirestore = false;
      if (!fromEnv && hasFirebaseAdminCredentials()) {
        try {
          const snap = await db.collection("settings").doc("gemini").get();
          const k = snap.data()?.apiKey;
          fromFirestore = typeof k === "string" && k.trim().length > 0;
        } catch {
          fromFirestore = false;
        }
      }
      const configured = fromEnv || fromFirestore;
      const source = fromEnv ? "environment" : fromFirestore ? "firestore" : "none";
      res.json({ ok: true, configured, source });
    } catch (e: unknown) {
      console.error("[Gemini status]", e);
      res.status(500).json({
        ok: false,
        configured: false,
        source: "none",
        error: e instanceof Error ? e.message : "status failed",
      });
    }
  });

  app.post("/api/gemini/chat", async (req, res) => {
    const apiKey = await getGeminiApiKey();
    if (!apiKey) {
      return res.status(503).json({
        error:
          "No Gemini API key: set GEMINI_API_KEY (Vercel) or save a key below in Admin → API Settings (Firestore).",
      });
    }

    try {
      const { prompt, history, mediaParts, doctors } = req.body as {
        prompt?: string;
        history?: unknown[];
        mediaParts?: unknown[];
        doctors?: { name: string; specialty: string }[];
      };

      const systemInstruction = buildSystemInstruction(doctors || []);
      const contents = normalizeChatContents(history || [], prompt || "", mediaParts || []);

      const text = await generateChatViaRest(apiKey, systemInstruction, contents);
      res.json({ text });
    } catch (e: unknown) {
      console.error("[Gemini chat]", e);
      const msg = e instanceof Error ? e.message : "Gemini request failed";
      res.status(500).json({ error: msg });
    }
  });

  app.post("/api/gemini/speech", async (req, res) => {
    const apiKey = await getGeminiApiKey();
    if (!apiKey) {
      return res.status(503).json({
        error:
          "No Gemini API key: set GEMINI_API_KEY (Vercel) or save a key below in Admin → API Settings (Firestore).",
      });
    }

    try {
      const { text } = req.body as { text?: string };
      if (!text?.trim()) {
        return res.status(400).json({ error: "text required" });
      }

      const ai = new GoogleGenAI({ apiKey });
      const response = await withTimeout(
        ai.models.generateContent({
          model: SPEECH_MODEL,
          contents: [{ role: "user", parts: [{ text: text.trim() }] }],
          config: {
            responseModalities: [Modality.AUDIO],
          },
        }),
        SPEECH_TIMEOUT_MS,
        "gemini_speech"
      );

      const audioBase64 = response.data ?? null;
      res.json({ audioBase64 });
    } catch (e: unknown) {
      console.error("[Gemini speech]", e);
      const msg = e instanceof Error ? e.message : "Gemini speech failed";
      res.status(500).json({ error: msg });
    }
  });
}
