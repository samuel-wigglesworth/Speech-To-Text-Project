# LTE Experiential Learning Platform – Speech Evaluator

> **Learn · Teach · Earn** — Speak in your own language, get evaluated, grow.

A fully-serverless Cloudflare Worker application that:

1. **Stores page content** (text, PDF, images, video/audio metadata) as the reference knowledge base in **KV**
2. **Transcribes** a learner's spoken explanation in any language using **Whisper** (`@cf/openai/whisper-large-v3-turbo`)
3. **Evaluates** the learner's understanding against the stored content using **Llama 3.1** (`@cf/meta/llama-3.1-8b-instruct`)
4. **Speaks back** personalised feedback in the learner's language using **Deepgram Aura** TTS (`@cf/deepgram/aura-1`)

Built as a **drag-and-drop** Cloudflare Pages/Workers project.

---

## Architecture

```
┌─────────────────────┐        ┌──────────────────────────────────┐
│   Browser Frontend  │        │     Cloudflare Worker (Edge)     │
│  (public/index.html)│◄──────►│  src/index.ts                    │
│                     │        │                                  │
│  ① Drop content     │        │  POST /api/content/upload        │
│  ② Record / drop    │        │  GET  /api/content/list          │
│     audio           │        │  POST /api/transcribe  (Whisper) │
│  ③ View results     │        │  POST /api/evaluate    (Llama)   │
│  ④ Play audio       │        │  POST /api/speak       (Aura TTS)│
└─────────────────────┘        │  POST /api/full-eval  (pipeline) │
                                └───────────────┬──────────────────┘
┌─────────────────────┐                        │
│  Python CLI         │                        ▼
│  python/            │        ┌──────────────────────────────────┐
│  content_loader.py  │───────►│  Cloudflare KV                   │
│                     │        │  (stores page content as context)│
└─────────────────────┘        └──────────────────────────────────┘
```

---

## LTE Stage Mapping

| LTE Stage (Page 4)        | Platform Feature                                  |
|---------------------------|---------------------------------------------------|
| **Pages** (Stage 5)       | Content uploaded via drop zone / Python CLI       |
| **Action Verbs** (Stage 6)| Embedded in the text content you upload           |
| **Experiencing**          | Learner speaks to explain their understanding     |
| **Reflecting**            | AI identifies strong/weak areas                   |
| **Thinking (HOT)**        | Missing concepts highlighted for further study    |
| **Acting**                | Score, level badge, and audio feedback motivate   |

---

## Quick Start

### 1. Prerequisites

- [Node.js](https://nodejs.org/) ≥ 18
- [Wrangler CLI](https://developers.cloudflare.com/workers/wrangler/): `npm install -g wrangler`
- A Cloudflare account with **Workers AI** enabled

### 2. Install dependencies

```bash
cd lte-evaluator
npm install
```

### 3. Create the KV namespace

```bash
# Create KV namespace for production
wrangler kv namespace create CONTENT_KV

# Create preview namespace for local dev
wrangler kv namespace create CONTENT_KV --preview
```

Copy the `id` values into `wrangler.jsonc`:

```jsonc
"kv_namespaces": [
  {
    "binding": "CONTENT_KV",
    "id": "PASTE_PRODUCTION_ID_HERE",
    "preview_id": "PASTE_PREVIEW_ID_HERE"
  }
]
```

### 4. Local development

```bash
npm run dev
# → http://localhost:8787
```

### 5. Deploy

```bash
npm run deploy
# → https://lte-evaluator.<your-subdomain>.workers.dev
```

---

## Uploading Content (Python CLI)

The Python script reads your page content files and pushes them to the Worker's KV store.

```bash
cd python
pip install -r requirements.txt

# Upload a folder of content files
python content_loader.py \
  --url https://lte-evaluator.your-subdomain.workers.dev \
  --path ./my_content_files

# Upload a single file
python content_loader.py \
  --url https://lte-evaluator.your-subdomain.workers.dev \
  --file module1/page3.txt \
  --key "module1-page3" \
  --title "Action Verbs – Deep Dive"

# Upload inline text (useful for quick testing)
python content_loader.py \
  --url https://lte-evaluator.your-subdomain.workers.dev \
  --text "Experiencing means learning begins when a learner uses senses..." \
  --key "eirh-experiencing" \
  --title "EIRH – Experiencing"

# List all stored content
python content_loader.py \
  --url https://lte-evaluator.your-subdomain.workers.dev \
  --list
```

**Supported file types:**

| Type  | Handling                                               |
|-------|--------------------------------------------------------|
| `.txt`, `.md` | Full text extracted and stored                |
| `.pdf` | Text extracted via PyPDF2 (install optional dep)      |
| `.jpg`, `.png`, `.gif` | Size/format metadata stored            |
| `.mp4`, `.webm` | Filename + size metadata stored              |
| `.mp3`, `.wav` | Filename + size metadata stored               |

---

## API Reference

### `POST /api/content/upload`

Upload reference content.

**JSON body:**
```json
{
  "key": "module1-page3",
  "title": "Action Verbs – Deep Dive",
  "type": "text",
  "content": "The full text of the page..."
}
```

**Multipart form:**
```
key=module1-page3
title=Action Verbs
type=text
file=<binary file>
```

---

### `GET /api/content/list`

Returns all stored content keys.

---

### `POST /api/transcribe`

Transcribe audio using Whisper.

```bash
curl -X POST /api/transcribe -F "audio=@recording.mp3"
```

**Response:**
```json
{
  "text": "The learner's spoken words here",
  "language": "en",
  "durationMs": 1240
}
```

---

### `POST /api/evaluate`

Evaluate a transcript against stored content.

```json
{
  "transcript": "I think experiencing means...",
  "content_keys": ["module1-page3"],
  "language_hint": "en"
}
```

**Response:**
```json
{
  "evaluation": {
    "language_detected": "en",
    "strong_areas": ["Concrete Experience", "Sensory engagement"],
    "weak_areas": ["Reflective Observation"],
    "missing_concepts": ["Abstract Conceptualization", "Active Experimentation"],
    "understanding_level": "Developing",
    "score_percent": 55,
    "conclusion": "...",
    "feedback_audio_text": "..."
  },
  "durationMs": 2800
}
```

---

### `POST /api/speak`

Convert text to speech (returns audio/mpeg binary).

```json
{ "text": "Well done! Your understanding is developing nicely..." }
```

---

### `POST /api/full-eval`

All-in-one pipeline (transcribe → evaluate → speak).

**Multipart form:**
```
audio=<audio file, max 2 MB>
language_hint=hi            (optional)
content_keys=key1,key2      (optional, defaults to all)
return_audio=true           (optional, default true)
```

**Response:**
```json
{
  "transcript": "...",
  "language_detected": "hi",
  "evaluation": { ... },
  "audio_base64": "<base64 mp3>",
  "audio_mime": "audio/mpeg",
  "timing": { "total_ms": 4200, "eval_ms": 3100, "tts_ms": 900 }
}
```

---

## Multilingual Support

- **Speech → Text**: Whisper supports 99+ languages automatically
- **Analysis**: Llama 3.1 has native multilingual support (English, French, German, Hindi, Italian, Portuguese, Spanish, Thai + more)
- **Feedback text**: The LLM is instructed to write feedback in the learner's detected language
- **Text → Speech**: Deepgram Aura currently produces English audio; for non-English learners the written feedback is shown on screen as well

---

## Understanding Levels

| Level       | Score Range | Meaning                                       |
|-------------|-------------|-----------------------------------------------|
| Beginner    | 0–29%       | Limited exposure, core concepts missing       |
| Developing  | 30–54%      | Basic grasp, significant gaps remain          |
| Proficient  | 55–69%      | Solid foundation, some areas need deepening   |
| Advanced    | 70–84%      | Strong understanding, minor gaps              |
| Expert      | 85–100%     | Deep mastery, ready to teach others           |

---

## Environment Variables

No secrets required beyond the standard Cloudflare Workers AI binding.
The AI and KV bindings are declared in `wrangler.jsonc`.

---

## License

MIT
