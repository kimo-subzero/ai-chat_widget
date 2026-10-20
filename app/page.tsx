'use client';
/* eslint-disable @next/next/no-img-element */

import { useState, useRef, useEffect } from 'react';

interface Attachment {
  name: string;
  type: string; // MIME type
  dataUrl: string; // data:...;base64,...
}

interface TextFile {
  name: string;
  text: string;
}

interface Message {
  role: 'user' | 'assistant';
  content: string;
  attachments?: Attachment[];
  textFiles?: TextFile[];
}

const MAX_BINARY_TOTAL = 3 * 1024 * 1024; // 3 MB of images/PDF per message (Vercel limit is ~4.5 MB)
const MAX_TEXT_FILE_CHARS = 20000;
const MAX_FILES = 3;
const TEXT_EXTENSIONS = [
  'txt', 'md', 'csv', 'json', 'js', 'jsx', 'ts', 'tsx', 'py',
  'html', 'css', 'xml', 'yml', 'yaml', 'log', 'sql',
];

const readAsDataUrl = (file: File) =>
  new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });

// Shrinks photos so they fit in the request (max 1600px, saved as JPEG)
const compressImage = (file: File) =>
  new Promise<string>((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, 1600 / Math.max(img.width, img.height));
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(img.width * scale);
      canvas.height = Math.round(img.height * scale);
      const ctx = canvas.getContext('2d');
      if (!ctx) {
        URL.revokeObjectURL(url);
        reject(new Error('Canvas not supported'));
        return;
      }
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      URL.revokeObjectURL(url);
      resolve(canvas.toDataURL('image/jpeg', 0.82));
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('Could not read image'));
    };
    img.src = url;
  });

// Approximate size in bytes of a base64 data URL
const dataUrlBytes = (dataUrl: string) =>
  Math.floor((dataUrl.length - dataUrl.indexOf(',') - 1) * 0.75);

export default function ChatWidget() {
  const [isOpen, setIsOpen] = useState(true);
  const [messages, setMessages] = useState<Message[]>([
    {
      role: 'assistant',
      content: 'Hello! I am Karim’s AI Assistant. How can I help you today?',
    },
  ]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [selectedModel, setSelectedModel] = useState('google/gemini-3.5-flash-lite');
  const [pendingAttachments, setPendingAttachments] = useState<Attachment[]>([]);
  const [pendingTextFiles, setPendingTextFiles] = useState<TextFile[]>([]);
  const [fileError, setFileError] = useState('');
  const chatEndRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const hasFiles = pendingAttachments.length > 0 || pendingTextFiles.length > 0;

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, loading]);

  const handleFiles = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []);
    e.target.value = '';
    setFileError('');

    let binaryBytes = pendingAttachments.reduce((sum, a) => sum + dataUrlBytes(a.dataUrl), 0);
    let count = pendingAttachments.length + pendingTextFiles.length;
    const newAttachments: Attachment[] = [];
    const newTextFiles: TextFile[] = [];

    for (const file of files) {
      if (count >= MAX_FILES) {
        setFileError(`Maximum ${MAX_FILES} files per message.`);
        break;
      }
      const ext = file.name.split('.').pop()?.toLowerCase() ?? '';

      try {
        if (file.type.startsWith('image/')) {
          const dataUrl = await compressImage(file);
          const bytes = dataUrlBytes(dataUrl);
          if (binaryBytes + bytes > MAX_BINARY_TOTAL) {
            setFileError('Files are too large (limit is about 3 MB in total).');
            continue;
          }
          binaryBytes += bytes;
          count++;
          newAttachments.push({ name: file.name, type: 'image/jpeg', dataUrl });
        } else if (file.type === 'application/pdf' || ext === 'pdf') {
          if (binaryBytes + file.size > MAX_BINARY_TOTAL) {
            setFileError('Files are too large (limit is about 3 MB in total).');
            continue;
          }
          const raw = await readAsDataUrl(file);
          const dataUrl = 'data:application/pdf;base64,' + raw.split(',')[1];
          binaryBytes += file.size;
          count++;
          newAttachments.push({ name: file.name, type: 'application/pdf', dataUrl });
        } else if (file.type.startsWith('text/') || TEXT_EXTENSIONS.includes(ext)) {
          if (file.size > 1024 * 1024) {
            setFileError(`"${file.name}" is too large (limit is 1 MB for text files).`);
            continue;
          }
          const text = (await file.text()).slice(0, MAX_TEXT_FILE_CHARS);
          count++;
          newTextFiles.push({ name: file.name, text });
        } else {
          setFileError(`"${file.name}" is not supported. Use images, PDF, or text files.`);
        }
      } catch {
        setFileError(`Could not read "${file.name}".`);
      }
    }

    setPendingAttachments((prev) => [...prev, ...newAttachments]);
    setPendingTextFiles((prev) => [...prev, ...newTextFiles]);
  };

  // Builds the messages sent to the API. Files are only sent with the newest message.
  const buildApiMessages = (list: Message[]) =>
    list.map((m, i) => {
      const isLast = i === list.length - 1;
      let content = m.content;
      m.textFiles?.forEach((f) => {
        content += `\n\n[File: ${f.name}]\n${f.text}`;
      });
      if (!isLast && m.attachments?.length) {
        content += `\n\n[Attached earlier: ${m.attachments.map((a) => a.name).join(', ')}]`;
      }
      return {
        role: m.role,
        content,
        attachments: isLast ? m.attachments : undefined,
      };
    });

  const sendMessage = async (e: React.FormEvent) => {
    e.preventDefault();
    if ((!input.trim() && !hasFiles) || loading) return;

    const userMsg: Message = {
      role: 'user',
      content: input.trim() || 'Please analyze the attached file(s).',
      attachments: pendingAttachments,
      textFiles: pendingTextFiles,
    };
    const updatedMessages = [...messages, userMsg];

    setMessages(updatedMessages);
    setInput('');
    setPendingAttachments([]);
    setPendingTextFiles([]);
    setFileError('');
    setLoading(true);

    try {
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messages: buildApiMessages(updatedMessages),
          model: selectedModel,
        }),
      });

      // If the server returns something that is not JSON (e.g. a 404 page),
      // fall back to an empty object instead of jumping to "Network error".
      const data = await res.json().catch(() => ({}));

      if (data.reply) {
        setMessages((prev) => [...prev, { role: 'assistant', content: data.reply }]);
      } else {
        setMessages((prev) => [
          ...prev,
          { role: 'assistant', content: 'Sorry, something went wrong. Please check your API configuration.' },
        ]);
      }
    } catch {
      setMessages((prev) => [
        ...prev,
        { role: 'assistant', content: 'Network error. Please try again later.' },
      ]);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 flex items-center justify-center p-4 relative font-sans">
      {/* Landing Background Graphic */}
      <div className="text-center max-w-xl">
        <h1 className="text-4xl font-extrabold tracking-tight sm:text-5xl bg-gradient-to-r from-blue-400 to-indigo-500 bg-clip-text text-transparent">
          AI Chatbot Widget
        </h1>
        <p className="mt-4 text-slate-400 text-lg">
          A production-ready embedding widget powered by Next.js & OpenRouter API. Built by <span className="text-indigo-400 font-semibold">Karim</span>.
        </p>
      </div>

      {/* Toggle Button for Floating Widget */}
      {!isOpen && (
        <button
          onClick={() => setIsOpen(true)}
          className="fixed bottom-6 right-6 bg-indigo-600 hover:bg-indigo-500 text-white p-4 rounded-full shadow-2xl transition-all duration-300 flex items-center gap-2 font-medium"
        >
          💬 Chat with AI
        </button>
      )}

      {/* Floating Chat Container */}
      {isOpen && (
        <div className="fixed bottom-6 right-6 w-full max-w-sm sm:max-w-md bg-slate-900 border border-slate-800 rounded-2xl shadow-2xl flex flex-col overflow-hidden transition-all duration-300 h-[550px] z-50">
          {/* Header */}
          <div className="bg-slate-800/80 backdrop-blur p-4 border-b border-slate-700/60 flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="w-3 h-3 rounded-full bg-emerald-500 animate-pulse" />
              <div>
                <h2 className="font-semibold text-sm text-slate-100">AI Support Agent</h2>
                <span className="text-xs text-slate-400">By Karim</span>
              </div>
            </div>

            <div className="flex items-center gap-2">
              {/* Model Selector */}
              <select
                value={selectedModel}
                onChange={(e) => setSelectedModel(e.target.value)}
                className="bg-slate-900 border border-slate-700 text-slate-300 text-xs rounded-lg px-2 py-1 outline-none focus:border-indigo-500"
              >
                <option value="google/gemini-3.5-flash-lite">Gemini 3.5 Flash Lite</option>
                <option value="google/gemini-3.5-flash">Gemini 3.5 Flash</option>
              </select>

              <button
                onClick={() => setIsOpen(false)}
                className="text-slate-400 hover:text-slate-200 text-sm font-bold px-2 py-1"
              >
                ✕
              </button>
            </div>
          </div>

          {/* Messages Feed */}
          <div className="flex-1 p-4 overflow-y-auto space-y-3 scrollbar-thin scrollbar-thumb-slate-700">
            {messages.map((msg, idx) => (
              <div
                key={idx}
                className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}
              >
                <div
                  className={`max-w-[85%] rounded-2xl px-4 py-2.5 text-sm leading-relaxed whitespace-pre-wrap ${
                    msg.role === 'user'
                      ? 'bg-indigo-600 text-white rounded-br-none'
                      : 'bg-slate-800 text-slate-200 border border-slate-700/50 rounded-bl-none'
                  }`}
                >
                  {msg.attachments?.map((a, i) =>
                    a.type.startsWith('image/') ? (
                      <img
                        key={i}
                        src={a.dataUrl}
                        alt={a.name}
                        className="mb-2 max-h-40 rounded-lg"
                      />
                    ) : (
                      <div key={i} className="mb-2 text-xs opacity-90">
                        📄 {a.name}
                      </div>
                    )
                  )}
                  {msg.textFiles?.map((f, i) => (
                    <div key={i} className="mb-2 text-xs opacity-90">
                      📄 {f.name}
                    </div>
                  ))}
                  {msg.content}
                </div>
              </div>
            ))}
            {loading && (
              <div className="flex justify-start">
                <div className="bg-slate-800 border border-slate-700/50 rounded-2xl rounded-bl-none px-4 py-3 text-slate-400 text-xs flex items-center gap-2">
                  <span className="animate-bounce">●</span>
                  <span className="animate-bounce delay-100">●</span>
                  <span className="animate-bounce delay-200">●</span>
                  <span>AI is thinking...</span>
                </div>
              </div>
            )}
            <div ref={chatEndRef} />
          </div>

          {/* Pending files + errors */}
          {(hasFiles || fileError) && (
            <div className="px-3 pt-2 bg-slate-800/50 border-t border-slate-800 space-y-2">
              {fileError && <div className="text-xs text-red-400">{fileError}</div>}
              {hasFiles && (
                <div className="flex flex-wrap gap-2">
                  {pendingAttachments.map((a, i) => (
                    <div
                      key={`a-${i}`}
                      className="flex items-center gap-2 bg-slate-900 border border-slate-700 rounded-lg px-2 py-1 text-xs text-slate-300"
                    >
                      {a.type.startsWith('image/') ? (
                        <img src={a.dataUrl} alt={a.name} className="h-6 w-6 rounded object-cover" />
                      ) : (
                        <span>📄</span>
                      )}
                      <span className="max-w-[120px] truncate">{a.name}</span>
                      <button
                        type="button"
                        onClick={() =>
                          setPendingAttachments((prev) => prev.filter((_, idx) => idx !== i))
                        }
                        className="text-slate-500 hover:text-slate-200"
                      >
                        ✕
                      </button>
                    </div>
                  ))}
                  {pendingTextFiles.map((f, i) => (
                    <div
                      key={`t-${i}`}
                      className="flex items-center gap-2 bg-slate-900 border border-slate-700 rounded-lg px-2 py-1 text-xs text-slate-300"
                    >
                      <span>📄</span>
                      <span className="max-w-[120px] truncate">{f.name}</span>
                      <button
                        type="button"
                        onClick={() =>
                          setPendingTextFiles((prev) => prev.filter((_, idx) => idx !== i))
                        }
                        className="text-slate-500 hover:text-slate-200"
                      >
                        ✕
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* Input Form */}
          <form onSubmit={sendMessage} className="p-3 bg-slate-800/50 border-t border-slate-800 flex items-center gap-2">
            <input
              ref={fileInputRef}
              type="file"
              multiple
              accept="image/*,application/pdf,.txt,.md,.csv,.json,.js,.jsx,.ts,.tsx,.py,.html,.css,.xml,.yml,.yaml,.log,.sql"
              onChange={handleFiles}
              className="hidden"
            />
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              disabled={loading}
              title="Attach images, PDF or text files"
              className="text-slate-400 hover:text-slate-200 disabled:opacity-50 px-2 py-2 text-lg"
            >
              📎
            </button>
            <input
              type="text"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="Ask anything..."
              className="flex-1 bg-slate-900 text-slate-100 text-sm rounded-xl px-4 py-2.5 border border-slate-700/60 focus:outline-none focus:border-indigo-500 placeholder-slate-500"
            />
            <button
              type="submit"
              disabled={loading || (!input.trim() && !hasFiles)}
              className="bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white text-sm font-semibold px-4 py-2.5 rounded-xl transition-all shadow-md"
            >
              Send
            </button>
          </form>
        </div>
      )}
    </div>
  );
}