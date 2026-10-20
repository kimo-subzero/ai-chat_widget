import { NextResponse } from "next/server";

// Models that the widget is allowed to use (OpenRouter model IDs).
const ALLOWED_MODELS = [
  "google/gemini-3.5-flash-lite", // cheaper / faster
  "google/gemini-3.5-flash",      // smarter
];
const DEFAULT_MODEL = ALLOWED_MODELS[0];

const SYSTEM_PROMPT =
  "You are a helpful, professional AI assistant built by Karim. Provide concise and accurate answers.";

const ALLOWED_ATTACHMENT_TYPES = [
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
  "application/pdf",
];
const MAX_ATTACHMENTS = 3;
const MAX_ATTACHMENT_CHARS = 4_200_000; // total base64 size (~3 MB of files)
const MAX_TEXT_CHARS = 60_000;

type Attachment = { name: string; type: string; dataUrl: string };
type ChatMessage = {
  role: "user" | "assistant";
  content: string;
  attachments?: Attachment[];
};

// Keep only valid, allowed attachments
function cleanAttachments(input: unknown): Attachment[] {
  if (!Array.isArray(input)) return [];
  const result: Attachment[] = [];
  let totalChars = 0;

  for (const a of input.slice(0, MAX_ATTACHMENTS)) {
    if (!a || typeof a.name !== "string" || typeof a.type !== "string" || typeof a.dataUrl !== "string") continue;
    if (!ALLOWED_ATTACHMENT_TYPES.includes(a.type)) continue;
    if (!a.dataUrl.startsWith(`data:${a.type};base64,`)) continue;

    totalChars += a.dataUrl.length;
    if (totalChars > MAX_ATTACHMENT_CHARS) break;

    result.push({ name: a.name.slice(0, 100), type: a.type, dataUrl: a.dataUrl });
  }
  return result;
}

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
    const rawMessages = Array.isArray(body?.messages) ? body.messages : [];
    const messages: ChatMessage[] = rawMessages
      .filter(
        (m: ChatMessage) =>
          (m?.role === "user" || m?.role === "assistant") &&
          typeof m?.content === "string"
      )
      .slice(-20)
      .map((m: ChatMessage) => ({
        role: m.role,
        content: m.content.slice(0, MAX_TEXT_CHARS),
        attachments: cleanAttachments(m.attachments),
      }));

    if (messages.length === 0) {
      return NextResponse.json({ reply: "No messages provided." }, { status: 400 });
    }

    const model = ALLOWED_MODELS.includes(body?.model) ? body.model : DEFAULT_MODEL;

    // Attachments are only sent with the newest user message.
    const lastIndex = messages.length - 1;
    const apiMessages = messages.map((m, i) => {
      const files = i === lastIndex && m.role === "user" ? m.attachments ?? [] : [];
      if (files.length === 0) return { role: m.role, content: m.content };

      return {
        role: m.role,
        content: [
          { type: "text", text: m.content },
          ...files.map((f) =>
            f.type === "application/pdf"
              ? { type: "file", file: { filename: f.name, file_data: f.dataUrl } }
              : { type: "image_url", image_url: { url: f.dataUrl } }
          ),
        ],
      };
    });

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
        max_tokens: 2048, // limits reply length so it fits your OpenRouter credits
        messages: [{ role: "system", content: SYSTEM_PROMPT }, ...apiMessages],
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