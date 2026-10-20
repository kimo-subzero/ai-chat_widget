import { NextResponse } from "next/server";

// Models that the widget is allowed to use (OpenRouter model IDs).
// Anything else (e.g. the old gemini-2.0-flash-001) falls back to DEFAULT_MODEL.
const ALLOWED_MODELS = [
  "google/gemini-3.5-flash-lite", // cheaper / faster
  "google/gemini-3.5-flash",      // smarter
];
const DEFAULT_MODEL = ALLOWED_MODELS[0];

const SYSTEM_PROMPT =
  "You are a helpful, professional AI assistant built by Karim. Provide concise and accurate answers.";

type ChatMessage = { role: "user" | "assistant"; content: string };

export async function POST(req: Request) {
  try {
    const body = await req.json();

    const apiKey = process.env.OPENROUTER_API_KEY;
    if (!apiKey) {
      return NextResponse.json(
        {
          reply:
            "Server error: OPENROUTER_API_KEY is not set. Add it in Vercel → Settings → Environment Variables, then redeploy.",
        },
        { status: 500 }
      );
    }

    // Only accept user/assistant messages from the browser (never "system"),
    // and keep the last 20 so requests stay small.
    const messages: ChatMessage[] = (Array.isArray(body?.messages) ? body.messages : [])
      .filter(
        (m: ChatMessage) =>
          (m?.role === "user" || m?.role === "assistant") &&
          typeof m?.content === "string"
      )
      .slice(-20);

    if (messages.length === 0) {
      return NextResponse.json({ reply: "No messages provided." }, { status: 400 });
    }

    const model = ALLOWED_MODELS.includes(body?.model) ? body.model : DEFAULT_MODEL;

    const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "HTTP-Referer": "https://ai-chat-widget-vqgp.vercel.app",
        "X-Title": "AI Chat Widget",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        messages: [{ role: "system", content: SYSTEM_PROMPT }, ...messages],
      }),
    });

    const data = await response.json().catch(() => null);

    if (!response.ok) {
      console.error("OpenRouter Error:", response.status, data);
      return NextResponse.json(
        { reply: `API Error: ${data?.error?.message || "Failed to fetch response"}` },
        { status: response.status }
      );
    }

    const reply = data?.choices?.[0]?.message?.content || "No response generated.";
    return NextResponse.json({ reply });
  } catch (error) {
    console.error("Server Catch Error:", error);
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json({ reply: `Server Exception: ${message}` }, { status: 500 });
  }
}