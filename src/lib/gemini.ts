/** Calls server-side Gemini routes so GEMINI_API_KEY stays on the server (Vercel env), not in the JS bundle. */

function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number
): Promise<Response> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  return fetch(url, { ...init, signal: ctrl.signal }).finally(() => clearTimeout(t));
}

export async function generateHealthResponse(
  prompt: string,
  history: unknown[] = [],
  mediaParts: unknown[] = [],
  doctors: { name: string; specialty: string }[] = []
) {
  let res: Response;
  try {
    res = await fetchWithTimeout(
      "/api/gemini/chat",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt, history, mediaParts, doctors }),
      },
      45_000
    );
  } catch (e: unknown) {
    const name = e instanceof Error ? e.name : (e as { name?: string })?.name;
    if (name === "AbortError") {
      throw new Error("Chat timed out. Check your connection and try again.");
    }
    throw e;
  }

  const data = (await res.json().catch(() => ({}))) as {
    text?: string;
    error?: string;
  };

  if (!res.ok) {
    throw new Error(data.error || `Chat request failed (${res.status})`);
  }

  return data.text ?? "";
}

export async function generateSpeech(text: string): Promise<string | null> {
  const res = await fetch("/api/gemini/speech", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text }),
  });

  const data = (await res.json().catch(() => ({}))) as {
    audioBase64?: string | null;
    error?: string;
  };

  if (!res.ok) {
    console.error("TTS Error:", data.error || res.statusText);
    return null;
  }

  return data.audioBase64 ?? null;
}

export async function fetchGeminiStatus(): Promise<{
  ok: boolean;
  configured: boolean;
  source?: string;
}> {
  const res = await fetch("/api/gemini/status");
  const data = (await res.json().catch(() => ({}))) as {
    ok?: boolean;
    configured?: boolean;
    source?: string;
  };
  if (!res.ok) {
    return { ok: false, configured: false, source: "none" };
  }
  return {
    ok: Boolean(data.ok),
    configured: Boolean(data.configured),
    source: data.source ?? "none",
  };
}
