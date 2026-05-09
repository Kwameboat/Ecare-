import { GoogleGenAI, Modality } from "@google/genai";
import { auth } from "./firebase";

const apiKey = process.env.GEMINI_API_KEY;
if (!apiKey) {
  console.warn("GEMINI_API_KEY is not defined in the environment. AI features will fail.");
}
const ai = new GoogleGenAI({ apiKey: apiKey || "" });

export async function generateHealthResponse(prompt: string, history: any[] = [], mediaParts: any[] = [], doctors: any[] = []) {
  const doctorsList = doctors.map(d => `${d.name} (${d.specialty})`).join(", ");
  const systemInstruction = `
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

  try {
    const contents = [
      ...history,
      { role: "user", parts: [{ text: prompt || "User sent audio/image" }, ...mediaParts] }
    ];

    const response = await ai.models.generateContent({
      model: "gemini-3-flash-preview", 
      contents,
      config: {
        systemInstruction,
      }
    });

    return response.text;
  } catch (error) {
    console.error("Gemini Error:", error);
    throw error;
  }
}

export async function generateSpeech(text: string) {
  try {
    const response = await ai.models.generateContent({
      model: "gemini-3.1-flash-tts-preview",
      contents: [{ parts: [{ text }] }],
      config: {
        responseModalities: [Modality.AUDIO],
        speechConfig: {
          voiceConfig: {
            prebuiltVoiceConfig: { voiceName: 'Kore' },
          },
        },
      },
    });

    const base64Audio = response.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;
    return base64Audio;
  } catch (error) {
    console.error("TTS Error:", error);
    return null;
  }
}
