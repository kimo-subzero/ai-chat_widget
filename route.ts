import { NextResponse } from 'next/server';

export async function POST(req: Request) {
  try {
    const { messages, model } = await req.json();

    const apiKey = process.env.OPENROUTER_API_KEY;
    if (!apiKey) {
      return NextResponse.json(
        { error: 'OpenRouter API Key is missing on Vercel.' },
        { status: 500 }
      );
    }

    // Default to Gemini 2.0 Flash if model issue occurs
    const selectedModel = model || 'google/gemini-2.0-flash-001';

    const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'HTTP-Referer': 'https://ai-chat-widget-vqgp.vercel.app',
        'X-Title': 'AI Chat Widget',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: selectedModel,
        messages: [
          {
            role: 'system',
            content: 'You are a helpful, professional AI assistant built by Karim. Provide concise and accurate answers.',
          },
          ...messages,
        ],
      }),
    });

    const data = await response.json();

    if (!response.ok) {
      console.error('OpenRouter Error:', data);
      return NextResponse.json(
        { reply: `API Error: ${data?.error?.message || 'Failed to fetch response'}` },
        { status: response.status }
      );
    }

    const reply = data.choices[0]?.message?.content || 'No response generated.';
    return NextResponse.json({ reply });

  } catch (error: any) {
    console.error('Server Catch Error:', error);
    return NextResponse.json(
      { reply: `Server Exception: ${error.message || 'Unknown error'}` },
      { status: 500 }
    );
  }
}