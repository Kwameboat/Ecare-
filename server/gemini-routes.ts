import type { Express } from "express";
import { GoogleGenAI, Modality } from "@google/genai";
import { db } from "./firebase-init.js";
import { getGeminiApiKey } from "./gemini-key.js";

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
      if (!fromEnv) {
        const snap = await db.collection("settings").doc("gemini").get();
        const k = snap.data()?.apiKey;
        fromFirestore = typeof k === "string" && k.trim().length > 0;
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

      const ai = new GoogleGenAI({ apiKey });
      const systemInstruction = buildSystemInstruction(doctors || []);
      const contents = [
        ...((history || []) as object[]),
        {
          role: "user",
          parts: [{ text: prompt || "User sent audio/image" }, ...(mediaParts || [])],
        },
      ];

      const response = await ai.models.generateContent({
        model: "gemini-3-flash-preview",
        contents,
        config: {
          systemInstruction,
        },
      });

      const text = response.text ?? "";
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
      const response = await ai.models.generateContent({
        model: "gemini-3.1-flash-tts-preview",
        contents: [{ role: "user", parts: [{ text: text.trim() }] }],
        config: {
          responseModalities: [Modality.AUDIO],
        },
      });

      const audioBase64 = response.data ?? null;
      res.json({ audioBase64 });
    } catch (e: unknown) {
      console.error("[Gemini speech]", e);
      const msg = e instanceof Error ? e.message : "Gemini speech failed";
      res.status(500).json({ error: msg });
    }
  });
}
