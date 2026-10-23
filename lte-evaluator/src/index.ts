/**
 * Interview Preparation Platform – Cloudflare Worker
 * v3.0
 *
 * Workflow:
 *   Learner selects an interview topic (or uploads custom content)
 *   → speaks their answer to a practice question
 *   → AI evaluates answer quality against ideal content
 *   → 2 follow-up drill questions per round (up to 5 rounds)
 *   → learner decides whether to continue or finish
 *   → session saved to D1, usage logged to KV
 *
 * KV stores:
 *   CONTENT_KV    – interview topic content (uploaded by admin)
 *   USER_MASTER_KV – email → { email, user_name }          (one entry per user)
 *   USER_LOGS_KV   – email:timestamp → login event          (who logged in when)
 *   USAGE_LOGS_KV  – email:timestamp → usage event          (who used the app when)
 *
 * D1 tables:
 *   users          – email PK, name, picture, google_sub, role, created_at
 *   monthly_counts – (email, year, month) PK, count
 *   sessions       – id PK, email, started_at, …, followup_rounds
 *
 * Auth routes:
 *   GET /auth/google      – redirect to Google consent
 *   GET /auth/callback    – exchange code → session cookie
 *   GET /auth/logout      – clear cookie
 *   GET /api/me           – current user + monthly count
 *
 * Admin routes (role = admin):
 *   GET /api/dashboard    – all users, login history, usage counts
 *
 * Content routes (require auth):
 *   POST /api/content/upload
 *   GET  /api/content/list
 *
 * Interview routes (require auth):
 *   POST /api/full-eval   – transcribe + evaluate + TTS, write D1 + KV
 *   POST /api/followup    – generate/evaluate follow-up drill questions
 *   GET  /api/stats       – learner's own stats
 *
 * Misc:
 *   GET /api/health
 */

export interface Env {
  AI:              Ai;
  CONTENT_KV:      KVNamespace;
  USER_MASTER_KV:  KVNamespace;
  USER_LOGS_KV:    KVNamespace;
  USAGE_LOGS_KV:   KVNamespace;
  DB:              D1Database;
  GOOGLE_CLIENT_ID:     string;
  GOOGLE_CLIENT_SECRET: string;
  COOKIE_SECRET:        string;
  APP_URL:              string;
}

// ─── Constants ────────────────────────────────────────────────────────────────
const WHISPER = "@cf/openai/whisper-large-v3-turbo" as const;
const LLM     = "@cf/meta/llama-3.1-8b-instruct-fast" as const;
const TTS     = "@cf/deepgram/aura-1" as const;

const MAX_AUDIO  = 2 * 1024 * 1024;
const SESS_KEY   = "ip_session";
const SESS_TTL   = 60 * 60 * 24 * 7; // 7 days

const CORS = {
  "Access-Control-Allow-Origin":  "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

// ─── Types ────────────────────────────────────────────────────────────────────
interface WhisperOut { text: string; transcription_info?: { language?: string }; }
interface LlmOut     { response?: unknown; }

interface EvalResult {
  language_detected?:   string;
  answer_summary?:      string;
  strong_points?:       string[];
  weak_points?:         string[];
  missing_concepts?:    string[];
  readiness_level?:     string;  // "Not Ready|Developing|Competent|Proficient|Interview-Ready"
  score_percent?:       number;
  feedback?:            string;
  feedback_audio_text?: string;
  raw_response?:        string;
}

interface SessionUser {
  email:   string;
  name:    string;
  picture: string;
  sub:     string;
  exp:     number;
}

interface UserMasterEntry { email: string; user_name: string; }
interface UserLogEntry    { email: string; logged_at: number; event: string; }
interface UsageLogEntry   { email: string; used_at: number;   action: string; }

// ─── Helpers ──────────────────────────────────────────────────────────────────
const J = (d: unknown, s = 200, h: Record<string,string> = {}) =>
  new Response(JSON.stringify(d), { status: s, headers: { ...CORS, "Content-Type": "application/json", ...h } });

const E = (msg: string, code: string, s: number) => J({ error: { code, message: msg } }, s);

function b64(buf: ArrayBuffer): string {
  const b = new Uint8Array(buf); let s = "";
  for (let i = 0; i < b.byteLength; i++) s += String.fromCharCode(b[i]);
  return btoa(s);
}
function uid(): string {
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40; b[8] = (b[8] & 0x3f) | 0x80;
  const h = Array.from(b).map(x => x.toString(16).padStart(2,"0")).join("");
  return `${h.slice(0,8)}-${h.slice(8,12)}-${h.slice(12,16)}-${h.slice(16,20)}-${h.slice(20)}`;
}
const now = () => Math.floor(Date.now() / 1000);
const isoDate = (ts: number) => new Date(ts * 1000).toISOString();

// ─── Session (HMAC-SHA256 mini-JWT) ──────────────────────────────────────────
async function signTok(p: SessionUser, secret: string): Promise<string> {
  const enc = new TextEncoder();
  const hdr = btoa(JSON.stringify({ alg:"HS256" })).replace(/=/g,"");
  const bdy = btoa(JSON.stringify(p)).replace(/=/g,"");
  const dat = `${hdr}.${bdy}`;
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name:"HMAC", hash:"SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(dat));
  const s64 = b64(sig).replace(/\+/g,"-").replace(/\//g,"_").replace(/=/g,"");
  return `${dat}.${s64}`;
}
async function verifyTok(tok: string, secret: string): Promise<SessionUser | null> {
  try {
    const [h,b,s] = tok.split(".");
    if (!h||!b||!s) return null;
    const enc = new TextEncoder();
    const dat = `${h}.${b}`;
    const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name:"HMAC", hash:"SHA-256" }, false, ["verify"]);
    const sf  = s.replace(/-/g,"+").replace(/_/g,"/");
    const sb  = Uint8Array.from(atob(sf), c => c.charCodeAt(0));
    if (!await crypto.subtle.verify("HMAC", key, sb, enc.encode(dat))) return null;
    const p = JSON.parse(atob(b)) as SessionUser;
    return p.exp < now() ? null : p;
  } catch { return null; }
}
function getToken(req: Request): string|null {
  const c = req.headers.get("Cookie") ?? "";
  return c.match(new RegExp(`(?:^|;\\s*)${SESS_KEY}=([^;]+)`))?.[1] ?? null;
}
async function getUser(req: Request, env: Env): Promise<SessionUser|null> {
  const t = getToken(req); return t ? verifyTok(t, env.COOKIE_SECRET) : null;
}
const authGuard = (u: SessionUser|null) => u ? null : E("Sign in with Google to continue.", "UNAUTHORIZED", 401);

// ─── KV log helpers ───────────────────────────────────────────────────────────

/** USER_MASTER_KV: key = email, value = JSON UserMasterEntry */
async function upsertUserMaster(kv: KVNamespace, email: string, name: string): Promise<void> {
  const entry: UserMasterEntry = { email, user_name: name };
  await kv.put(email, JSON.stringify(entry));
}

/** USER_LOGS_KV: key = email:timestamp, value = JSON UserLogEntry */
async function writeUserLog(kv: KVNamespace, email: string, event: string): Promise<void> {
  const ts  = now();
  const key = `${email}:${ts}`;
  const entry: UserLogEntry = { email, logged_at: ts, event };
  await kv.put(key, JSON.stringify(entry), { expirationTtl: 60 * 60 * 24 * 90 }); // 90-day retention
}

/** USAGE_LOGS_KV: key = email:timestamp, value = JSON UsageLogEntry */
async function writeUsageLog(kv: KVNamespace, email: string, action: string): Promise<void> {
  const ts  = now();
  const key = `${email}:${ts}`;
  const entry: UsageLogEntry = { email, used_at: ts, action };
  await kv.put(key, JSON.stringify(entry), { expirationTtl: 60 * 60 * 24 * 90 });
}

// ─── D1 helpers ──────────────────────────────────────────────────────────────
async function d1UpsertUser(db: D1Database, u: SessionUser): Promise<void> {
  await db.prepare(
    `INSERT INTO users (email,name,picture,google_sub,role,created_at) VALUES(?,?,?,?,'learner',?)
     ON CONFLICT(email) DO UPDATE SET name=excluded.name, picture=excluded.picture, google_sub=excluded.google_sub`
  ).bind(u.email, u.name, u.picture, u.sub, now()).run();
}
async function d1IncrMonth(db: D1Database, email: string): Promise<number> {
  const d = new Date(); const y = d.getUTCFullYear(); const m = d.getUTCMonth()+1;
  await db.prepare(
    `INSERT INTO monthly_counts(email,year,month,count) VALUES(?,?,?,1)
     ON CONFLICT(email,year,month) DO UPDATE SET count=count+1`
  ).bind(email,y,m).run();
  const r = await db.prepare(`SELECT count FROM monthly_counts WHERE email=? AND year=? AND month=?`).bind(email,y,m).first<{count:number}>();
  return r?.count ?? 1;
}
async function d1SaveSession(db: D1Database, id: string, email: string, keys: string[], transcript: string, lang: string, ev: EvalResult): Promise<void> {
  await db.prepare(
    `INSERT INTO sessions(id,email,started_at,content_keys,transcript,language_detected,score_percent,understanding_level,evaluation_json,followup_rounds)
     VALUES(?,?,?,?,?,?,?,?,?,0)`
  ).bind(id, email, now(), JSON.stringify(keys), transcript, lang, ev.score_percent??null, ev.readiness_level??null, JSON.stringify(ev)).run();
}
async function d1IncrFollowup(db: D1Database, id: string): Promise<void> {
  await db.prepare(`UPDATE sessions SET followup_rounds=followup_rounds+1 WHERE id=?`).bind(id).run();
}

// ─── AI helpers ──────────────────────────────────────────────────────────────
async function whisper(env: Env, audio64: string, lang?: string): Promise<WhisperOut> {
  const inp: Record<string,unknown> = { audio: audio64 };
  if (lang) inp.language = lang;
  const run = env.AI.run.bind(env.AI) as (m:string,i:Record<string,unknown>)=>Promise<unknown>;
  return (await run(WHISPER, inp)) as WhisperOut;
}
async function llm(env: Env, system: string, user: string): Promise<string> {
  const r = (await env.AI.run(LLM, { messages:[{role:"system",content:system},{role:"user",content:user}], max_tokens:512 })) as LlmOut;
  const v = r?.response; if (typeof v==="string") return v; if (v&&typeof v==="object") return JSON.stringify(v); return "";
}
async function tts(env: Env, text: string): Promise<ArrayBuffer> {
  const run = env.AI.run.bind(env.AI) as (m:string,i:Record<string,unknown>,o:Record<string,unknown>)=>Promise<unknown>;
  const resp = (await run(TTS, {text, speaker:"asteria", encoding:"mp3"}, {returnRawResponse:true})) as Response;
  if (!resp.ok) throw new Error(`TTS ${resp.status}`);
  return resp.arrayBuffer();
}
function parseJSON(raw: unknown): EvalResult {
  let s: string;
  if (typeof raw==="string") s=raw;
  else if (raw&&typeof raw==="object") { try { return raw as EvalResult; } catch { s=JSON.stringify(raw); } }
  else return {raw_response:""};
  try { return JSON.parse(s.replace(/^```json\s*/i,"").replace(/^```\s*/i,"").replace(/\s*```$/i,"").trim()) as EvalResult; }
  catch { return {raw_response:s}; }
}

// ─── Prompts ──────────────────────────────────────────────────────────────────
function evalPrompt(ctx: string): string {
  const c = ctx.length>2000 ? ctx.slice(0,2000)+"\n[truncated]" : ctx;
  return `You are an expert interview coach evaluating a candidate's spoken answer for a job interview.

IDEAL ANSWER / REFERENCE CONTENT:
${c}

Score the candidate's answer and reply with ONLY a JSON object, no markdown:
{"language_detected":"<ISO 639-1>","answer_summary":"<1 sentence>","strong_points":["<item>"],"weak_points":["<item>"],"missing_concepts":["<item>"],"readiness_level":"<Not Ready|Developing|Competent|Proficient|Interview-Ready>","score_percent":<0-100>,"feedback":"<2 sentences of constructive feedback>","feedback_audio_text":"<spoken feedback to play aloud, in the candidate's language, encouraging but honest>"}`;
}

function followupPrompt(ev: EvalResult, ctx: string, round: number): string {
  const c = ctx.length>1500 ? ctx.slice(0,1500)+"\n[truncated]" : ctx;
  return `You are an interview coach running a drill session (round ${round}).

REFERENCE CONTENT:
${c}

CANDIDATE PERFORMANCE SO FAR:
- Score: ${ev.score_percent??0}%
- Level: ${ev.readiness_level??"?"}
- Strong: ${(ev.strong_points??[]).join(", ")||"none"}
- Weak:   ${(ev.weak_points??[]).join(", ")||"none"}
- Missing: ${(ev.missing_concepts??[]).join(", ")||"none"}

Generate exactly 2 probing follow-up interview questions targeting the weak points and missing concepts.
Reply with ONLY a JSON object:
{"questions":["<q1>","<q2>"],"encouragement":"<1 short encouraging sentence>"}`;
}

function drillEvalPrompt(qs: string[], as: string[], ctx: string): string {
  const c = ctx.length>1500 ? ctx.slice(0,1500)+"\n[truncated]" : ctx;
  const qa = qs.map((q,i)=>`Q${i+1}: ${q}\nA${i+1}: ${as[i]??"(no answer)"}`).join("\n\n");
  return `You are an interview coach evaluating drill answers.

REFERENCE CONTENT:
${c}

DRILL ANSWERS:
${qa}

Reply with ONLY a JSON object:
{"improved_areas":["<area>"],"still_weak":["<area>"],"summary":"<2 sentences>","suggest_more_questions":<true|false>,"feedback_audio_text":"<spoken feedback in candidate's language>"}`;
}

// ─── Auth handlers ────────────────────────────────────────────────────────────
function googleLogin(env: Env): Response {
  const sb = new Uint8Array(16); crypto.getRandomValues(sb);
  const state = b64(sb.buffer);
  const p = new URLSearchParams({
    client_id:env.GOOGLE_CLIENT_ID, redirect_uri:`${env.APP_URL}/auth/callback`,
    response_type:"code", scope:"openid email profile", state, access_type:"online", prompt:"select_account"
  });
  return new Response(null, { status:302, headers:{Location:`https://accounts.google.com/o/oauth2/v2/auth?${p}`} });
}

async function googleCallback(req: Request, env: Env): Promise<Response> {
  const code = new URL(req.url).searchParams.get("code");
  if (!code) return E("Missing code","OAUTH_ERROR",400);
  const tr = await fetch("https://oauth2.googleapis.com/token", {
    method:"POST", headers:{"Content-Type":"application/x-www-form-urlencoded"},
    body: new URLSearchParams({ code, client_id:env.GOOGLE_CLIENT_ID, client_secret:env.GOOGLE_CLIENT_SECRET, redirect_uri:`${env.APP_URL}/auth/callback`, grant_type:"authorization_code" }),
  });
  if (!tr.ok) return E(`Token exchange failed: ${await tr.text()}`,"OAUTH_ERROR",502);
  const {id_token} = await tr.json() as {id_token?:string};
  if (!id_token) return E("No id_token","OAUTH_ERROR",502);
  const [,pb64] = id_token.split(".");
  const prof = JSON.parse(atob(pb64.replace(/-/g,"+").replace(/_/g,"/"))) as {sub:string;email:string;name:string;picture:string};
  const su: SessionUser = { email:prof.email, name:prof.name??"", picture:prof.picture??"", sub:prof.sub, exp:now()+SESS_TTL };

  // Write to D1 + all three KV stores
  await Promise.all([
    d1UpsertUser(env.DB, su),
    upsertUserMaster(env.USER_MASTER_KV, su.email, su.name),
    writeUserLog(env.USER_LOGS_KV, su.email, "login"),
  ]);

  const tok = await signTok(su, env.COOKIE_SECRET);
  const co  = [`${SESS_KEY}=${tok}`, "HttpOnly", "SameSite=Lax", "Path=/", `Max-Age=${SESS_TTL}`];
  if (env.APP_URL.startsWith("https://")) co.push("Secure");
  return new Response(null, { status:302, headers:{ Location:"/", "Set-Cookie":co.join("; ") } });
}

function logout(): Response {
  return new Response(null, { status:302, headers:{ Location:"/", "Set-Cookie":`${SESS_KEY}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0` } });
}

async function me(req: Request, env: Env): Promise<Response> {
  const u = await getUser(req, env);
  if (!u) return J({user:null});
  const d = new Date();
  const row = await env.DB.prepare(`SELECT count FROM monthly_counts WHERE email=? AND year=? AND month=?`)
    .bind(u.email, d.getUTCFullYear(), d.getUTCMonth()+1).first<{count:number}>();
  // get role
  const uRow = await env.DB.prepare(`SELECT role FROM users WHERE email=?`).bind(u.email).first<{role:string}>();
  return J({ user:{email:u.email,name:u.name,picture:u.picture,role:uRow?.role??"learner"}, monthly_count:row?.count??0 });
}

// ─── Dashboard (admin) ────────────────────────────────────────────────────────
async function dashboard(req: Request, env: Env): Promise<Response> {
  const u = await getUser(req, env);
  const g = authGuard(u); if (g) return g;

  // Check admin role
  const uRow = await env.DB.prepare(`SELECT role FROM users WHERE email=?`).bind(u!.email).first<{role:string}>();
  if (uRow?.role !== "admin") return E("Admin access required","FORBIDDEN",403);

  // 1. All users from USER_MASTER_KV
  const masterList = await env.USER_MASTER_KV.list({ limit: 100 });
  const users = await Promise.all(masterList.keys.map(async k => {
    const v = await env.USER_MASTER_KV.get(k.name);
    return v ? JSON.parse(v) as UserMasterEntry : null;
  }));

  // 2. All login events from USER_LOGS_KV
  const loginList = await env.USER_LOGS_KV.list({ limit: 200 });
  const logins = await Promise.all(loginList.keys.map(async k => {
    const v = await env.USER_LOGS_KV.get(k.name);
    return v ? JSON.parse(v) as UserLogEntry : null;
  }));

  // 3. All usage events from USAGE_LOGS_KV
  const usageList = await env.USAGE_LOGS_KV.list({ limit: 200 });
  const usages = await Promise.all(usageList.keys.map(async k => {
    const v = await env.USAGE_LOGS_KV.get(k.name);
    return v ? JSON.parse(v) as UsageLogEntry : null;
  }));

  // 4. Monthly counts from D1 for all users
  const monthlyCounts = await env.DB.prepare(
    `SELECT email, year, month, count FROM monthly_counts ORDER BY year DESC, month DESC`
  ).all<{email:string;year:number;month:number;count:number}>();

  // 5. Usage summary: compute daily & monthly counts from usage logs
  const usageByDay:   Record<string, number> = {};
  const usageByMonth: Record<string, number> = {};
  for (const e of usages.filter(Boolean) as UsageLogEntry[]) {
    const d   = new Date(e.used_at * 1000);
    const day = `${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,"0")}-${String(d.getUTCDate()).padStart(2,"0")}`;
    const mon = `${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,"0")}`;
    usageByDay[day]   = (usageByDay[day]   ?? 0) + 1;
    usageByMonth[mon] = (usageByMonth[mon] ?? 0) + 1;
  }

  return J({
    users:         users.filter(Boolean),
    logins:        logins.filter(Boolean).sort((a,b) => (b as UserLogEntry).logged_at - (a as UserLogEntry).logged_at),
    usages:        usages.filter(Boolean).sort((a,b) => (b as UsageLogEntry).used_at   - (a as UsageLogEntry).used_at),
    monthly_d1:    monthlyCounts.results ?? [],
    summary: {
      total_users:   users.filter(Boolean).length,
      total_logins:  logins.filter(Boolean).length,
      total_usages:  usages.filter(Boolean).length,
      usage_by_day:   usageByDay,
      usage_by_month: usageByMonth,
    },
  });
}

// ─── Content handlers ─────────────────────────────────────────────────────────
async function uploadContent(req: Request, env: Env): Promise<Response> {
  const ct = req.headers.get("Content-Type")??"";
  let key: string, text: string, meta: Record<string,string>={};
  if (ct.includes("multipart/form-data")) {
    const f  = await req.formData();
    key      = (f.get("key") as string|null)?? `topic-${Date.now()}`;
    const ti = (f.get("title") as string|null)??key;
    const ty = (f.get("type") as string|null)??"text";
    const tc = f.get("text_content") as string|null;
    const fi = f.get("file") as File|null;
    if (tc) text=tc;
    else if (fi) {
      if (fi.type.startsWith("text/")||fi.type==="application/pdf"||fi.name.endsWith(".txt")||fi.name.endsWith(".md")) text=await fi.text();
      else text=`[${ty.toUpperCase()} FILE: ${fi.name}, ${fi.size} bytes]`;
    } else return E("Provide text_content or file","MISSING_CONTENT",400);
    meta={title:ti,type:ty,uploadedAt:new Date().toISOString()};
  } else if (ct.includes("application/json")) {
    const b  = await req.json() as {key?:string;title?:string;type?:string;content:string};
    if (!b.content) return E("Missing content","MISSING_CONTENT",400);
    key=b.key??`topic-${Date.now()}`; text=b.content;
    meta={title:b.title??key,type:b.type??"text",uploadedAt:new Date().toISOString()};
  } else return E("Unsupported Content-Type","UNSUPPORTED_TYPE",415);
  await env.CONTENT_KV.put(key, text, {metadata:meta});
  return J({success:true,key,bytes:text.length,meta});
}

async function listContent(env: Env): Promise<Response> {
  const l = await env.CONTENT_KV.list();
  return J({keys:l.keys.map(k=>({name:k.name,metadata:k.metadata})),complete:l.list_complete});
}

async function getCtx(env: Env, keys: string[]): Promise<string> {
  const ks = keys.length>0 ? keys : (await env.CONTENT_KV.list({limit:20})).keys.map(k=>k.name);
  const cs = await Promise.all(ks.map(k=>env.CONTENT_KV.get(k)));
  return cs.filter(Boolean).join("\n\n---\n\n");
}

// ─── Full evaluation pipeline ─────────────────────────────────────────────────
async function fullEval(req: Request, env: Env, u: SessionUser): Promise<Response> {
  const f        = await req.formData();
  const af       = f.get("audio") as File|null;
  const kr       = (f.get("content_keys") as string|null)??"";
  const lh       = (f.get("language_hint") as string|null)??"";
  const doAudio  = f.get("return_audio")!=="false";

  if (!af||!(af instanceof File)) return E("Missing audio","INVALID_AUDIO",400);
  if (af.size===0||af.size>MAX_AUDIO)  return E("Audio must be ≤ 2 MB","AUDIO_SIZE",400);

  const t0   = Date.now();
  const a64  = b64(await af.arrayBuffer());
  const cks  = kr.split(",").map(k=>k.trim()).filter(Boolean);

  // 1. Transcribe
  let wh: WhisperOut;
  try { wh = await whisper(env, a64, lh||undefined); }
  catch(e) { return E(`Transcription failed: ${e}`,"TRANSCRIBE_ERROR",502); }
  if (!wh?.text) return E("Empty transcription","TRANSCRIBE_ERROR",502);
  const transcript = wh.text.trim();
  const lang = wh.transcription_info?.language ?? lh ?? "en";

  // 2. Content context
  const ctx = await getCtx(env, cks);
  if (!ctx) return E("No interview content found. Upload a topic first.","NO_CONTENT",422);

  // 3. Evaluate
  let raw: string;
  try { raw = await llm(env, evalPrompt(ctx), `Candidate language: ${lang}\n\nCandidate answer:\n\n${transcript}`); }
  catch(e) { return E(`Evaluation failed: ${e}`,"LLM_ERROR",502); }
  const ev = parseJSON(raw);

  // 4. TTS (non-fatal)
  let aud: string|null = null;
  if (doAudio && ev.feedback_audio_text) {
    try { aud = b64(await tts(env, ev.feedback_audio_text)); }
    catch(e) { console.error("TTS failed:",String(e)); }
  }

  // 5. Persist — D1 + KV
  const sid   = uid();
  const mCnt  = await d1IncrMonth(env.DB, u.email);
  await d1SaveSession(env.DB, sid, u.email, cks, transcript, lang, ev);
  await writeUsageLog(env.USAGE_LOGS_KV, u.email, "interview_eval");

  return J({ session_id:sid, transcript, language_detected:ev.language_detected??lang, evaluation:ev, audio_base64:aud, audio_mime:aud?"audio/mpeg":null, monthly_count:mCnt, timing:{total_ms:Date.now()-t0} });
}

// ─── Follow-up drill ──────────────────────────────────────────────────────────
async function followup(req: Request, env: Env, u: SessionUser): Promise<Response> {
  const b = await req.json() as { session_id:string; round:number; answers?:string[]; questions?:string[]; };
  if (!b.session_id) return E("Missing session_id","MISSING_FIELD",400);

  const row = await env.DB.prepare(`SELECT evaluation_json, content_keys FROM sessions WHERE id=? AND email=?`)
    .bind(b.session_id, u.email).first<{evaluation_json:string;content_keys:string}>();
  if (!row) return E("Session not found","NOT_FOUND",404);

  const ev  = JSON.parse(row.evaluation_json) as EvalResult;
  const cks = JSON.parse(row.content_keys) as string[];
  const ctx = await getCtx(env, cks);

  // Round 0: generate 2 questions
  if (b.round===0) {
    let rq: string;
    try { rq = await llm(env, followupPrompt(ev, ctx, 1), "Generate 2 follow-up interview questions."); }
    catch(e) { return E(`Question generation failed: ${e}`,"LLM_ERROR",502); }
    let p: {questions:string[];encouragement:string};
    try { p=JSON.parse(rq.replace(/^```json\s*/i,"").replace(/```$/i,"").trim()); }
    catch { p={questions:["Tell me more about your approach.","How would you handle a challenge in this area?"],encouragement:"Keep going!"}; }
    return J({type:"questions",questions:p.questions,encouragement:p.encouragement,round:1});
  }

  // Round N: evaluate answers
  if (!b.answers||!b.questions) return E("Missing answers/questions","MISSING_FIELD",400);
  let re: string;
  try { re = await llm(env, drillEvalPrompt(b.questions, b.answers, ctx), "Evaluate these drill answers."); }
  catch(e) { return E(`Drill evaluation failed: ${e}`,"LLM_ERROR",502); }

  let dr: {improved_areas:string[];still_weak:string[];summary:string;suggest_more_questions:boolean;feedback_audio_text:string};
  try { dr=JSON.parse(re.replace(/^```json\s*/i,"").replace(/```$/i,"").trim()); }
  catch { dr={improved_areas:[],still_weak:[],summary:re,suggest_more_questions:false,feedback_audio_text:re}; }

  let aud: string|null=null;
  if (dr.feedback_audio_text) { try { aud=b64(await tts(env,dr.feedback_audio_text)); } catch{} }

  await d1IncrFollowup(env.DB, b.session_id);
  await writeUsageLog(env.USAGE_LOGS_KV, u.email, "followup_drill");

  let nextQs: string[]|null = null;
  if (dr.suggest_more_questions && b.round<5) {
    try {
      const nq = await llm(env, followupPrompt({...ev,weak_points:dr.still_weak}, ctx, b.round+1), "Generate 2 more drill questions.");
      nextQs   = JSON.parse(nq.replace(/^```json\s*/i,"").replace(/```$/i,"").trim()).questions;
    } catch {}
  }

  return J({ type:"evaluation", improved_areas:dr.improved_areas, still_weak:dr.still_weak, summary:dr.summary, suggest_more:dr.suggest_more_questions&&b.round<5, next_questions:nextQs, audio_base64:aud, audio_mime:aud?"audio/mpeg":null, round:b.round });
}

// ─── Stats ────────────────────────────────────────────────────────────────────
async function stats(req: Request, env: Env, u: SessionUser): Promise<Response> {
  const d = new Date();
  const [mRow, tRow, recent] = await Promise.all([
    env.DB.prepare(`SELECT count FROM monthly_counts WHERE email=? AND year=? AND month=?`).bind(u.email,d.getUTCFullYear(),d.getUTCMonth()+1).first<{count:number}>(),
    env.DB.prepare(`SELECT SUM(count) as total FROM monthly_counts WHERE email=?`).bind(u.email).first<{total:number}>(),
    env.DB.prepare(`SELECT started_at,score_percent,understanding_level,language_detected,followup_rounds FROM sessions WHERE email=? ORDER BY started_at DESC LIMIT 10`).bind(u.email).all<{started_at:number;score_percent:number;understanding_level:string;language_detected:string;followup_rounds:number}>(),
  ]);
  return J({ this_month:mRow?.count??0, all_time:tRow?.total??0, recent:recent.results??[] });
}

// ─── Main fetch handler ───────────────────────────────────────────────────────
export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    if (req.method==="OPTIONS") return new Response(null,{status:204,headers:CORS});
    const url = new URL(req.url); const p = url.pathname; const m = req.method.toUpperCase();
    try {
      if (p==="/auth/google"   && m==="GET") return googleLogin(env);
      if (p==="/auth/callback" && m==="GET") return await googleCallback(req,env);
      if (p==="/auth/logout"   && m==="GET") return logout();
      if (p==="/api/me"        && m==="GET") return await me(req,env);
      if (p==="/api/health"    && m==="GET") return J({status:"ok",version:"3.0.0"});

      const u = await getUser(req,env);

      if (p==="/api/dashboard"       && m==="GET")  { const g=authGuard(u); if(g)return g; return await dashboard(req,env); }
      if (p==="/api/content/upload"  && m==="POST") { const g=authGuard(u); if(g)return g; return await uploadContent(req,env); }
      if (p==="/api/content/list"    && m==="GET")  { const g=authGuard(u); if(g)return g; return await listContent(env); }
      if (p==="/api/full-eval"       && m==="POST") { const g=authGuard(u); if(g)return g; return await fullEval(req,env,u!); }
      if (p==="/api/followup"        && m==="POST") { const g=authGuard(u); if(g)return g; return await followup(req,env,u!); }
      if (p==="/api/stats"           && m==="GET")  { const g=authGuard(u); if(g)return g; return await stats(req,env,u!); }
      if (p.startsWith("/api/")) return E("Not found","NOT_FOUND",404);
    } catch(e) {
      console.error("Worker error:",String(e));
      return E(`Internal error: ${String(e)}`,"INTERNAL_ERROR",500);
    }
    return new Response("Not found",{status:404});
  },
};
