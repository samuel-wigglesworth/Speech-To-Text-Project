/**
 * LTE Experiential Learning Platform – Speech Evaluation Worker
 *
 * Endpoints:
 *   POST /api/content/upload   – Upload page content (text/pdf/image/video metadata)
 *   GET  /api/content/list     – List all stored content keys
 *   POST /api/transcribe       – Transcribe learner audio → text (Whisper large-v3-turbo)
 *   POST /api/evaluate         – Evaluate transcript vs content (Llama 3.1 8B fast)
 *   POST /api/speak            – Convert evaluation text → audio (Deepgram Aura TTS)
 *   POST /api/full-eval        – All-in-one pipeline: transcribe → evaluate → speak
 */

export interface Env {
  AI: Ai;
  CONTENT_KV: KVNamespace;
}

// ─── Constants ────────────────────────────────────────────────────────────────
const WHISPER_MODEL = "@cf/openai/whisper-large-v3-turbo" as const;
const LLM_MODEL     = "@cf/meta/llama-3.1-8b-instruct-fast" as const;
const TTS_MODEL     = "@cf/deepgram/aura-1" as const;

const MAX_AUDIO_BYTES = 2 * 1024 * 1024; // 2 MB

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, X-Content-Key",
};

// ─── Type helpers ─────────────────────────────────────────────────────────────
interface WhisperOutput {
  text: string;
  transcription_info?: {
    language?: string;
    language_probability?: number;
    duration?: number;
  };
  word_count?: number;
  segments?: { text?: string; start?: number; end?: number }[];
  vtt?: string;
}

interface LlmOutput {
  response?: unknown; // Intentionally unknown — runtime may return object or string
}

interface EvaluationResult {
  language_detected?: string;
  transcript_summary?: string;
  strong_areas?: string[];
  weak_areas?: string[];
  missing_concepts?: string[];
  understanding_level?: string;
  score_percent?: number;
  conclusion?: string;
  feedback_audio_text?: string;
  raw_response?: string;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
  });
}

function apiErr(message: string, code: string, status: number): Response {
  return json({ error: { code, message } }, status);
}

/** Convert ArrayBuffer → base64 string */
function toBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

/**
 * Build the system prompt for the LLM evaluator.
 * Content is capped at 2000 chars to stay within model input limits.
 */
function buildEvalPrompt(contentContext: string): string {
  const ctx = contentContext.length > 2000
    ? contentContext.slice(0, 2000) + "\n[...truncated]"
    : contentContext;

  return `You are an educational evaluator for the LTE learning platform. Evaluate the learner's spoken explanation against the reference content below.

REFERENCE CONTENT:
${ctx}

Reply with ONLY a JSON object, no markdown, no extra text:
{"language_detected":"<ISO 639-1 code>","transcript_summary":"<1 sentence>","strong_areas":["<item>"],"weak_areas":["<item>"],"missing_concepts":["<item>"],"understanding_level":"<Beginner|Developing|Proficient|Advanced|Expert>","score_percent":<0-100>,"conclusion":"<2 sentences>","feedback_audio_text":"<spoken feedback in the learner's detected language>"}`;
}

/**
 * Run Whisper on a base64 audio string.
 * The workers-types union for `audio` is `string | {body?,contentType?}`;
 * base64 string is correct at runtime so we cast through unknown.
 */
async function runWhisper(
  env: Env,
  audioBase64: string,
  languageHint?: string
): Promise<WhisperOutput> {
  const inputs: Record<string, unknown> = { audio: audioBase64 };
  if (languageHint) inputs.language = languageHint;

  const aiRun = env.AI.run.bind(env.AI) as (
    model: string,
    inputs: Record<string, unknown>
  ) => Promise<unknown>;

  return (await aiRun(WHISPER_MODEL, inputs)) as WhisperOutput;
}

/**
 * Run Deepgram Aura TTS.
 * Uses returnRawResponse:true — the binding returns a ReadableStream of raw MPEG audio.
 * We collect it into an ArrayBuffer and base64-encode it for the JSON response.
 */
async function runTTS(env: Env, text: string, speaker = "asteria"): Promise<ArrayBuffer> {
  const aiRun = env.AI.run.bind(env.AI) as (
    model: string,
    inputs: Record<string, unknown>,
    options: Record<string, unknown>
  ) => Promise<unknown>;

  // returnRawResponse:true makes the binding return a Response object whose
  // body is the raw audio stream instead of a post-processed wrapper.
  const rawResponse = (await aiRun(
    TTS_MODEL,
    { text, speaker, encoding: "mp3" },
    { returnRawResponse: true }
  )) as Response;

  if (!rawResponse.ok) {
    const errText = await rawResponse.text().catch(() => String(rawResponse.status));
    throw new Error(`TTS model returned ${rawResponse.status}: ${errText}`);
  }

  return rawResponse.arrayBuffer();
}

/**
 * Parse the LLM response into an EvaluationResult.
 * Guards against the LLM returning an object instead of a string,
 * and strips any accidental markdown code fences.
 */
function parseLLMJson(raw: unknown): EvaluationResult {
  // Normalise to string — if Workers AI returns an object, stringify it
  let str: string;
  if (typeof raw === "string") {
    str = raw;
  } else if (raw !== null && raw !== undefined) {
    // Already an object — try direct use first
    try {
      return raw as EvaluationResult;
    } catch {
      str = JSON.stringify(raw);
    }
  } else {
    return { raw_response: "" };
  }

  try {
    const cleaned = str
      .replace(/^```json\s*/i, "")
      .replace(/^```\s*/i, "")
      .replace(/\s*```$/i, "")
      .trim();
    return JSON.parse(cleaned) as EvaluationResult;
  } catch {
    return { raw_response: str };
  }
}

// ─── Route handlers ───────────────────────────────────────────────────────────

/** Upload page content into KV for later context matching */
async function handleContentUpload(request: Request, env: Env): Promise<Response> {
  const contentType = request.headers.get("Content-Type") ?? "";

  let key: string;
  let contentText: string;
  let meta: Record<string, string> = {};

  if (contentType.includes("multipart/form-data")) {
    const form = await request.formData();
    key = (form.get("key") as string | null) ?? `content-${Date.now()}`;
    const title = (form.get("title") as string | null) ?? key;
    const type  = (form.get("type")  as string | null) ?? "text";

    const textContent = form.get("text_content") as string | null;
    const file        = form.get("file") as File | null;

    if (textContent) {
      contentText = textContent;
    } else if (file) {
      if (
        file.type.startsWith("text/") ||
        file.type === "application/pdf" ||
        file.name.endsWith(".txt") ||
        file.name.endsWith(".md")
      ) {
        contentText = await file.text();
      } else {
        contentText = `[${type.toUpperCase()} FILE: ${file.name}, size: ${file.size} bytes, type: ${file.type}]`;
      }
    } else {
      return apiErr("Provide either text_content or a file", "MISSING_CONTENT", 400);
    }
    meta = { title, type, uploadedAt: new Date().toISOString() };

  } else if (contentType.includes("application/json")) {
    const body = (await request.json()) as {
      key?: string;
      title?: string;
      type?: string;
      content: string;
    };
    if (!body.content) {
      return apiErr("Missing 'content' field", "MISSING_CONTENT", 400);
    }
    key         = body.key   ?? `content-${Date.now()}`;
    contentText = body.content;
    meta        = {
      title:      body.title ?? key,
      type:       body.type  ?? "text",
      uploadedAt: new Date().toISOString(),
    };
  } else {
    return apiErr("Unsupported Content-Type", "UNSUPPORTED_TYPE", 415);
  }

  await env.CONTENT_KV.put(key, contentText, { metadata: meta });
  return json({ success: true, key, bytes: contentText.length, meta });
}

/** List all stored content keys */
async function handleContentList(env: Env): Promise<Response> {
  const list = await env.CONTENT_KV.list();
  return json({
    keys:     list.keys.map((k) => ({ name: k.name, metadata: k.metadata })),
    complete: list.list_complete, // true = all keys returned (was incorrectly inverted before)
  });
}

/** Transcribe audio using Whisper */
async function handleTranscribe(request: Request, env: Env): Promise<Response> {
  const form = await request.formData();
  const file = form.get("audio") as File | null;

  if (!file || !(file instanceof File)) {
    return apiErr("Missing 'audio' field (multipart)", "INVALID_AUDIO", 400);
  }
  if (file.size === 0 || file.size > MAX_AUDIO_BYTES) {
    return apiErr("Audio must be between 1 byte and 2 MB", "AUDIO_SIZE", 400);
  }
  if (!file.type.startsWith("audio/")) {
    return apiErr("File must be an audio/* type", "INVALID_AUDIO_TYPE", 400);
  }

  const t0     = Date.now();
  const buffer = await file.arrayBuffer();
  const b64    = toBase64(buffer);

  let result: WhisperOutput;
  try {
    result = await runWhisper(env, b64);
  } catch (e) {
    return apiErr(`Transcription failed: ${String(e)}`, "TRANSCRIBE_ERROR", 502);
  }

  if (!result?.text) {
    return apiErr("Transcription returned empty result", "TRANSCRIBE_ERROR", 502);
  }

  return json({
    text:       result.text.trim(),
    language:   result.transcription_info?.language ?? "unknown",
    durationMs: Date.now() - t0,
  });
}

/** Evaluate learner understanding against stored content */
async function handleEvaluate(request: Request, env: Env): Promise<Response> {
  const body = (await request.json()) as {
    transcript:    string;
    content_keys?: string[];
    language_hint?: string;
  };

  if (!body.transcript?.trim()) {
    return apiErr("Missing 'transcript'", "MISSING_TRANSCRIPT", 400);
  }

  // Gather content context from KV
  let contentContext = "";
  if (body.content_keys?.length) {
    const chunks = await Promise.all(body.content_keys.map((k) => env.CONTENT_KV.get(k)));
    contentContext = chunks.filter(Boolean).join("\n\n---\n\n");
  } else {
    const list   = await env.CONTENT_KV.list({ limit: 20 });
    const chunks = await Promise.all(list.keys.map((k) => env.CONTENT_KV.get(k.name)));
    contentContext = chunks.filter(Boolean).join("\n\n---\n\n");
  }

  if (!contentContext) {
    return apiErr(
      "No content found in KV. Upload content first via the Upload panel.",
      "NO_CONTENT",
      422
    );
  }

  const systemPrompt = buildEvalPrompt(contentContext);
  const userMessage  = body.language_hint
    ? `Learner language hint: ${body.language_hint}\n\nLearner explanation:\n\n${body.transcript}`
    : `Learner explanation:\n\n${body.transcript}`;

  const t0 = Date.now();
  let llmResult: LlmOutput;
  try {
    llmResult = (await env.AI.run(LLM_MODEL, {
      messages:   [{ role: "system", content: systemPrompt }, { role: "user", content: userMessage }],
      max_tokens: 512,
    })) as LlmOutput;
  } catch (e) {
    return apiErr(`Analysis failed: ${String(e)}`, "LLM_ERROR", 502);
  }

  const evaluation = parseLLMJson(llmResult?.response);
  return json({ evaluation, durationMs: Date.now() - t0 });
}

/** Convert text to speech using Deepgram Aura on Workers AI */
async function handleSpeak(request: Request, env: Env): Promise<Response> {
  const body = (await request.json()) as { text: string; speaker?: string };

  if (!body.text?.trim()) {
    return apiErr("Missing 'text'", "MISSING_TEXT", 400);
  }

  const t0 = Date.now();
  let audioBuffer: ArrayBuffer;
  try {
    audioBuffer = await runTTS(env, body.text, body.speaker ?? "asteria");
  } catch (e) {
    return apiErr(`TTS failed: ${String(e)}`, "TTS_ERROR", 502);
  }

  return new Response(audioBuffer, {
    status:  200,
    headers: { ...CORS_HEADERS, "Content-Type": "audio/mpeg", "X-Duration-Ms": String(Date.now() - t0) },
  });
}

/**
 * All-in-one pipeline:
 *   1. Transcribe audio   (Whisper large-v3-turbo)
 *   2. Evaluate transcript (Llama 3.1 8B fast)
 *   3. Convert feedback   (Deepgram Aura TTS)
 */
async function handleFullEval(request: Request, env: Env): Promise<Response> {
  const form = await request.formData();

  const audioFile      = form.get("audio")        as File   | null;
  const contentKeysRaw = form.get("content_keys") as string | null;
  const languageHint   = (form.get("language_hint") as string | null) ?? "";
  const returnAudio    = form.get("return_audio") !== "false";

  // ── Validate audio ──────────────────────────────────────────────────────────
  if (!audioFile || !(audioFile instanceof File)) {
    return apiErr("Missing 'audio' field", "INVALID_AUDIO", 400);
  }
  if (audioFile.size === 0 || audioFile.size > MAX_AUDIO_BYTES) {
    return apiErr("Audio must be between 1 byte and 2 MB", "AUDIO_SIZE", 400);
  }

  const t0          = Date.now();
  const audioBuffer = await audioFile.arrayBuffer();
  const audioB64    = toBase64(audioBuffer);

  // ── Step 1: Transcribe ──────────────────────────────────────────────────────
  let whisperResult: WhisperOutput;
  try {
    whisperResult = await runWhisper(env, audioB64, languageHint || undefined);
  } catch (e) {
    return apiErr(`Transcription failed: ${String(e)}`, "TRANSCRIBE_ERROR", 502);
  }

  if (!whisperResult?.text) {
    return apiErr("Transcription returned empty result", "TRANSCRIBE_ERROR", 502);
  }

  const transcript   = whisperResult.text.trim();
  const detectedLang = whisperResult.transcription_info?.language ?? languageHint ?? "en";

  // ── Step 2: Gather content context ─────────────────────────────────────────
  let contentContext = "";
  const contentKeys  = contentKeysRaw
    ? contentKeysRaw.split(",").map((k) => k.trim()).filter(Boolean)
    : [];

  if (contentKeys.length > 0) {
    const chunks   = await Promise.all(contentKeys.map((k) => env.CONTENT_KV.get(k)));
    contentContext = chunks.filter(Boolean).join("\n\n---\n\n");
  } else {
    const list     = await env.CONTENT_KV.list({ limit: 20 });
    const chunks   = await Promise.all(list.keys.map((k) => env.CONTENT_KV.get(k.name)));
    contentContext = chunks.filter(Boolean).join("\n\n---\n\n");
  }

  if (!contentContext) {
    return apiErr(
      "No content uploaded yet. Use the Upload panel to add page content first.",
      "NO_CONTENT",
      422
    );
  }

  // ── Step 3: Evaluate ────────────────────────────────────────────────────────
  const systemPrompt = buildEvalPrompt(contentContext);
  const userMessage  = `Learner language: ${detectedLang}\n\nLearner explanation:\n\n${transcript}`;

  let llmResult: LlmOutput;
  try {
    llmResult = (await env.AI.run(LLM_MODEL, {
      messages:   [{ role: "system", content: systemPrompt }, { role: "user", content: userMessage }],
      max_tokens: 512,
    })) as LlmOutput;
  } catch (e) {
    return apiErr(`Analysis failed: ${String(e)}`, "LLM_ERROR", 502);
  }

  const evaluation = parseLLMJson(llmResult?.response);

  // ── Step 4: Text-to-Speech (non-fatal) ─────────────────────────────────────
  let audioBase64: string | null   = null;
  let ttsDurationMs                = 0;

  if (returnAudio && evaluation.feedback_audio_text) {
    const t1 = Date.now();
    try {
      const audioBuffer = await runTTS(env, evaluation.feedback_audio_text, "asteria");
      audioBase64       = toBase64(audioBuffer);
      ttsDurationMs     = Date.now() - t1;
    } catch (e) {
      // TTS failure is non-fatal — written feedback is still returned
      console.error("TTS failed (non-fatal):", String(e));
    }
  }

  return json({
    transcript,
    language_detected: evaluation.language_detected ?? detectedLang,
    evaluation,
    audio_base64: audioBase64,
    audio_mime:   audioBase64 ? "audio/mpeg" : null,
    timing: {
      total_ms: Date.now() - t0,
      tts_ms:   ttsDurationMs,
    },
  });
}

// ─── Main fetch handler ───────────────────────────────────────────────────────
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    // CORS preflight
    if (request.method.toUpperCase() === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    const url    = new URL(request.url);
    const path   = url.pathname;
    const method = request.method.toUpperCase();

    // Wrap every route in a top-level try/catch so any unhandled
    // throw returns a clean JSON error instead of a 1101.
    try {
      if (path === "/api/content/upload" && method === "POST")  return await handleContentUpload(request, env);
      if (path === "/api/content/list"   && method === "GET")   return await handleContentList(env);
      if (path === "/api/transcribe"     && method === "POST")  return await handleTranscribe(request, env);
      if (path === "/api/evaluate"       && method === "POST")  return await handleEvaluate(request, env);
      if (path === "/api/speak"          && method === "POST")  return await handleSpeak(request, env);
      if (path === "/api/full-eval"      && method === "POST")  return await handleFullEval(request, env);
      if (path === "/api/health"         && method === "GET")   return json({ status: "ok", version: "1.1.0" });
      if (path.startsWith("/api/"))                             return apiErr("Not found", "NOT_FOUND", 404);
    } catch (e) {
      console.error("Unhandled worker error:", String(e));
      return apiErr(`Internal error: ${String(e)}`, "INTERNAL_ERROR", 500);
    }

    return new Response("Not found", { status: 404 });
  },
};
