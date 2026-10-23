"use strict";

const API = "";

// ─── State ────────────────────────────────────────────────────────────────────
let currentUser      = null;
let currentSessionId = null;
let followupRound    = 0;
let pendingQuestions = [];

// ─── Utility ─────────────────────────────────────────────────────────────────
const $ = id => document.getElementById(id);

function showToast(msg, type = "info") {
  const t = $("toast");
  t.textContent = msg;
  t.className   = `toast toast-${type}`;
  requestAnimationFrame(() => t.classList.add("show"));
  setTimeout(() => t.classList.remove("show"), 3500);
}

function fmtBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024*1024) return `${(n/1024).toFixed(1)} KB`;
  return `${(n/1024/1024).toFixed(2)} MB`;
}

function fmtDate(ts) {
  return new Date(ts * 1000).toLocaleString(undefined, {
    year:"numeric", month:"short", day:"numeric", hour:"2-digit", minute:"2-digit"
  });
}

function safeStr(v, fb = "-") {
  if (v == null) return fb;
  if (typeof v === "string") return v.trim() || fb;
  if (typeof v === "number") return String(v);
  try { return JSON.stringify(v); } catch { return fb; }
}

function fileTypeLabel(m) {
  if (!m) return "File";
  if (m.startsWith("image/")) return "Image";
  if (m.startsWith("audio/")) return "Audio";
  if (m.startsWith("video/")) return "Video";
  if (m === "application/pdf") return "PDF";
  return "Text";
}

const delay = ms => new Promise(r => setTimeout(r, ms));

// ─── Boot / Auth ──────────────────────────────────────────────────────────────
async function boot() {
  try {
    const d = await fetch(`${API}/api/me`).then(r => r.json());
    if (d.user) { currentUser = d.user; showApp(d.user, d.monthly_count ?? 0); }
    else showLogin();
  } catch { showLogin(); }
}

function showLogin() { $("login-gate").hidden = false; $("app").hidden = true; }

function showApp(user, count) {
  $("login-gate").hidden = true; $("app").hidden = false;
  $("user-name").textContent    = user.name || user.email;
  $("user-email").textContent   = user.email;
  $("header-count").textContent = count;
  if (user.picture) { $("user-avatar").src = user.picture; $("user-avatar").hidden = false; }
  if (user.role === "admin") $("open-dashboard-btn").hidden = false;
}

// ─── Drag-and-drop ────────────────────────────────────────────────────────────
function draggable(zone, onDrop) {
  zone.addEventListener("dragover",  e => { e.preventDefault(); zone.classList.add("drag-over"); });
  zone.addEventListener("dragleave", ()  => zone.classList.remove("drag-over"));
  zone.addEventListener("drop", e => {
    e.preventDefault(); zone.classList.remove("drag-over");
    const fs = Array.from(e.dataTransfer.files);
    if (fs.length) onDrop(fs);
  });
  zone.addEventListener("click", e => { if (e.target.tagName === "BUTTON") return; zone.querySelector("input[type=file]")?.click(); });
  zone.addEventListener("keydown", e => { if (e.key==="Enter"||e.key===" ") { e.preventDefault(); zone.querySelector("input[type=file]")?.click(); } });
}

// ════════════════════════════════════════════════════════════════
//  PANEL 1 – Upload Topic Content
// ════════════════════════════════════════════════════════════════
let contentFiles = [];

draggable($("content-drop-zone"), fs => { contentFiles.push(...fs); renderFiles(); });
$("content-file-btn").addEventListener("click", () => $("content-file-input").click());
$("content-file-input").addEventListener("change", () => {
  contentFiles.push(...Array.from($("content-file-input").files));
  $("content-file-input").value = "";
  renderFiles();
});

function renderFiles() {
  const ul = $("content-file-list");
  ul.innerHTML = "";
  contentFiles.forEach((f, i) => {
    const li = document.createElement("li");
    li.innerHTML = `
      <span class="file-icon">${fileTypeLabel(f.type)}</span>
      <span class="file-name" title="${f.name}">${f.name}</span>
      <span class="file-size">${fmtBytes(f.size)}</span>
      <button class="remove-file" data-idx="${i}">&times;</button>`;
    ul.appendChild(li);
  });
  ul.querySelectorAll(".remove-file").forEach(b =>
    b.addEventListener("click", e => { e.stopPropagation(); contentFiles.splice(+b.dataset.idx,1); renderFiles(); })
  );
  $("content-upload-btn").disabled = !contentFiles.length;
}

$("content-upload-btn").addEventListener("click", async () => {
  if (!contentFiles.length) return;
  const btn = $("content-upload-btn");
  btn.disabled = true; btn.textContent = "Uploading...";
  const results = [];
  for (const f of contentFiles) {
    const fd = new FormData();
    fd.append("key",   f.name.replace(/[^a-z0-9._-]/gi,"-").toLowerCase());
    fd.append("title", f.name);
    fd.append("type",  f.type.split("/")[0]||"text");
    fd.append("file",  f);
    try { results.push(await fetch(`${API}/api/content/upload`,{method:"POST",body:fd}).then(r=>r.json())); }
    catch(e) { results.push({error:String(e)}); }
  }
  $("content-result").hidden = false;
  $("content-result").textContent = JSON.stringify(results, null, 2);
  contentFiles = []; renderFiles();
  btn.textContent = "Upload Selected Files";
  showToast("Topic uploaded.", "success");
});

$("manual-upload-btn").addEventListener("click", async () => {
  const key     = $("manual-key").value.trim()   || `topic-${Date.now()}`;
  const title   = $("manual-title").value.trim() || key;
  const content = $("manual-content").value.trim();
  if (!content) { showToast("Please enter content.", "error"); return; }
  const btn = $("manual-upload-btn");
  btn.disabled = true; btn.textContent = "Saving...";
  try {
    const r = await fetch(`${API}/api/content/upload`, {
      method:"POST", headers:{"Content-Type":"application/json"},
      body: JSON.stringify({key, title, type:"text", content}),
    });
    const d = await r.json();
    $("content-result").hidden = false;
    $("content-result").textContent = JSON.stringify(d, null, 2);
    $("manual-key").value = ""; $("manual-title").value = ""; $("manual-content").value = "";
    showToast(`Topic "${key}" saved.`, "success");
  } catch(e) { showToast(`Save failed: ${e}`, "error"); }
  finally { btn.disabled = false; btn.textContent = "Save Topic"; }
});

// Topics modal
const openModal  = () => $("content-modal-overlay").classList.add("is-open");
const closeModal = () => $("content-modal-overlay").classList.remove("is-open");
$("content-list-btn").addEventListener("click", openTopicsModal);
$("refresh-keys-btn").addEventListener("click", openTopicsModal);
$("modal-close-btn").addEventListener("click", closeModal);
$("content-modal-overlay").addEventListener("click", e => { if (e.target===$("content-modal-overlay")) closeModal(); });

async function openTopicsModal() {
  openModal();
  const ul = $("stored-keys-list");
  ul.innerHTML = "<li style='color:var(--text-muted);font-size:.85rem'>Loading...</li>";
  $("no-keys-msg").hidden = true;
  try {
    const d = await fetch(`${API}/api/content/list`).then(r => r.json());
    ul.innerHTML = "";
    if (!d.keys?.length) { $("no-keys-msg").hidden = false; return; }
    d.keys.forEach(k => {
      const li = document.createElement("li");
      li.innerHTML = `<span class="key-name">${k.name}</span><span class="key-type">${k.metadata?.title ?? k.metadata?.type ?? "-"}</span>`;
      li.addEventListener("click", () => {
        $("eval-content-key").value = k.name;
        closeModal();
        showToast(`Topic "${k.name}" selected.`, "info");
      });
      ul.appendChild(li);
    });
  } catch(e) { ul.innerHTML = `<li style='color:var(--danger)'>Error: ${e}</li>`; }
}

// ════════════════════════════════════════════════════════════════
//  PANEL 2 – Record Answer
// ════════════════════════════════════════════════════════════════
let audioBlob = null, audioFile = null;

draggable($("audio-drop-zone"), fs => setAudio(fs[0]));
$("audio-file-btn").addEventListener("click", () => $("audio-file-input").click());
$("audio-file-input").addEventListener("change", () => {
  if ($("audio-file-input").files[0]) setAudio($("audio-file-input").files[0]);
  $("audio-file-input").value = "";
});

function setAudio(f) {
  if (!f.type.startsWith("audio/")) { showToast("Select an audio file.", "error"); return; }
  if (f.size > 2*1024*1024) { showToast("Audio must be ≤ 2 MB.", "error"); return; }
  audioFile = f; audioBlob = null;
  showAudioLabel(`File: ${f.name} (${fmtBytes(f.size)})`);
}
function showAudioLabel(s) {
  $("selected-audio-label").textContent = s;
  $("selected-audio-label").hidden = false;
  $("evaluate-btn").disabled = false;
}

let recorder=null, chunks=[], timerInt=null, secs=0;

$("rec-start-btn").addEventListener("click", async () => {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({audio:true});
    chunks = [];
    recorder = new MediaRecorder(stream, {mimeType:"audio/webm"});
    recorder.ondataavailable = e => { if (e.data.size>0) chunks.push(e.data); };
    recorder.onstop = () => {
      const blob = new Blob(chunks, {type:"audio/webm"});
      if (blob.size > 2*1024*1024) { showToast("Recording too large.", "error"); return; }
      audioBlob = blob; audioFile = null;
      const url = URL.createObjectURL(blob);
      $("rec-playback").src = url; $("rec-playback").hidden = false;
      showAudioLabel(`Recorded audio (${fmtBytes(blob.size)})`);
    };
    recorder.start(100);
    $("rec-start-btn").disabled = true; $("rec-stop-btn").disabled = false;
    $("rec-status").textContent = "Recording...";
    secs = 0; $("rec-timer").textContent = "0:00";
    timerInt = setInterval(() => {
      secs++;
      $("rec-timer").textContent = `${Math.floor(secs/60)}:${String(secs%60).padStart(2,"0")}`;
      if (secs >= 90) stopRec();
    }, 1000);
  } catch(e) { showToast(`Microphone denied: ${e.message}`, "error"); }
});

$("rec-stop-btn").addEventListener("click", stopRec);
function stopRec() {
  if (recorder && recorder.state !== "inactive") { recorder.stop(); recorder.stream.getTracks().forEach(t=>t.stop()); }
  clearInterval(timerInt);
  $("rec-start-btn").disabled = false; $("rec-stop-btn").disabled = true;
  $("rec-status").textContent = "Recording stopped.";
}

// ════════════════════════════════════════════════════════════════
//  EVALUATION PIPELINE
// ════════════════════════════════════════════════════════════════
$("evaluate-btn").addEventListener("click", runEval);

async function runEval() {
  const audio = audioBlob ? new File([audioBlob],"answer.webm",{type:"audio/webm"}) : audioFile;
  if (!audio) { showToast("Please record or select audio.", "error"); return; }

  $("evaluate-btn").disabled = true; $("evaluate-btn").textContent = "Evaluating...";
  $("progress-steps").hidden = false;
  $("panel-results").hidden  = true;
  $("panel-followup").hidden = true;

  setStep("transcribe","active"); setStep("evaluate","pending"); setStep("speak","pending");

  const fd = new FormData();
  fd.append("audio", audio);
  const lang = $("lang-hint").value;
  const key  = $("eval-content-key").value.trim();
  if (lang) fd.append("language_hint", lang);
  if (key)  fd.append("content_keys",  key);
  fd.append("return_audio", "true");

  try {
    const timer = setTimeout(() => setStep("evaluate","active"), 3000);
    const res   = await fetch(`${API}/api/full-eval`, {method:"POST", body:fd});
    clearTimeout(timer);

    if (!res.ok) {
      let msg = `Server error (HTTP ${res.status})`;
      try { msg = (await res.json())?.error?.message ?? msg; }
      catch { const t = await res.text().catch(()=>""); if (t.includes("1101")) msg = "Workers AI is busy. Please try again."; }
      throw new Error(msg);
    }

    setStep("transcribe","done"); setStep("evaluate","done"); setStep("speak","active");
    const data = await res.json();
    setStep("speak", data.audio_base64 ? "done" : "pending");
    await delay(300);

    currentSessionId = data.session_id;
    followupRound    = 0;
    pendingQuestions = [];
    if (data.monthly_count) $("header-count").textContent = data.monthly_count;

    renderResults(data);
  } catch(e) {
    showToast(e.message, "error");
    setStep("transcribe","pending"); setStep("evaluate","pending"); setStep("speak","pending");
  } finally {
    $("evaluate-btn").disabled = false; $("evaluate-btn").textContent = "Evaluate My Answer";
  }
}

const STEPS = {
  transcribe: {pending:"Transcribing your answer...",   active:"Transcribing your answer...",   done:"Transcription complete"},
  evaluate:   {pending:"Analysing interview readiness...", active:"Analysing interview readiness...", done:"Analysis complete"},
  speak:      {pending:"Generating coaching feedback...",  active:"Generating coaching feedback...",  done:"Coaching feedback ready"},
};
function setStep(name, state) {
  const el = $(`step-${name}`); if (!el) return;
  el.textContent = STEPS[name][state];
  el.className   = `step ${state}`;
}

function renderResults(data) {
  const ev    = data.evaluation ?? {};
  const score = Number(ev.score_percent ?? 0);

  setTimeout(() => { $("score-bar").style.width=`${score}%`; $("score-value").textContent=`${score}%`; }, 100);
  $("understanding-badge").textContent = safeStr(ev.readiness_level, "Unknown");
  $("result-transcript").textContent   = safeStr(data.transcript ?? ev.answer_summary);
  $("result-lang").textContent         = safeStr(data.language_detected ?? ev.language_detected);

  renderTags("result-strong",  ev.strong_points);
  renderTags("result-weak",    ev.weak_points);
  renderTags("result-missing", ev.missing_concepts);

  $("result-conclusion").textContent = safeStr(ev.feedback) !== "-"
    ? safeStr(ev.feedback) : safeStr(ev.raw_response);

  const sec = $("audio-feedback-section");
  if (data.audio_base64) {
    $("feedback-audio").src = `data:${data.audio_mime??"audio/mpeg"};base64,${data.audio_base64}`;
    sec.hidden = false;
    $("download-audio-btn").onclick = () => {
      const a = document.createElement("a"); a.href=$("feedback-audio").src; a.download="coaching.mp3"; a.click();
    };
  } else sec.hidden = true;

  $("panel-results").hidden = false;
  $("panel-results").scrollIntoView({behavior:"smooth",block:"start"});
}

function renderTags(id, items) {
  const ul = $(id); ul.innerHTML = "";
  if (!Array.isArray(items)||!items.length) { ul.classList.add("empty"); return; }
  ul.classList.remove("empty");
  items.forEach(x => { const li=document.createElement("li"); li.textContent=safeStr(x); ul.appendChild(li); });
}

$("try-again-btn").addEventListener("click", () => {
  $("panel-results").hidden=true; $("panel-followup").hidden=true;
  $("progress-steps").hidden=true; $("selected-audio-label").hidden=true;
  audioBlob=null; audioFile=null; $("evaluate-btn").disabled=true;
  $("rec-playback").hidden=true; $("rec-playback").src="";
  $("rec-status").textContent="Ready to record"; $("rec-timer").textContent="0:00";
  currentSessionId=null; followupRound=0;
  $("panel-evaluate").scrollIntoView({behavior:"smooth",block:"start"});
});

// ════════════════════════════════════════════════════════════════
//  PANEL 4 – Follow-up Drill
// ════════════════════════════════════════════════════════════════
$("start-followup-btn").addEventListener("click", startDrill);

async function startDrill() {
  if (!currentSessionId) { showToast("No active session.", "error"); return; }
  const btn = $("start-followup-btn");
  btn.disabled=true; btn.textContent="Loading questions...";
  try {
    const r = await fetch(`${API}/api/followup`, {
      method:"POST", headers:{"Content-Type":"application/json"},
      body: JSON.stringify({session_id:currentSessionId, round:0}),
    });
    const d = await r.json();
    if (!r.ok) throw new Error(d?.error?.message ?? `HTTP ${r.status}`);
    showDrillQuestions(d.questions, d.encouragement, 1);
  } catch(e) { showToast(`Failed: ${e.message}`, "error"); }
  finally { btn.disabled=false; btn.textContent="Start Drill Questions"; }
}

function showDrillQuestions(qs, enc, round) {
  pendingQuestions = qs;
  followupRound    = round;
  $("followup-round-num").textContent   = round;
  $("followup-encouragement").textContent = enc || "Keep practising.";
  $("fq-label-1").textContent = qs[0] ?? "";
  $("fq-label-2").textContent = qs[1] ?? "";
  $("fq-answer-1").value = ""; $("fq-answer-2").value = "";
  $("followup-result").hidden       = true;
  $("more-questions-prompt").hidden = true;
  $("followup-done-msg").hidden     = true;
  $("panel-followup").hidden = false;
  $("panel-followup").scrollIntoView({behavior:"smooth",block:"start"});
}

$("submit-followup-btn").addEventListener("click", submitDrill);

async function submitDrill() {
  const a1 = $("fq-answer-1").value.trim();
  const a2 = $("fq-answer-2").value.trim();
  if (!a1 && !a2) { showToast("Please answer at least one question.", "error"); return; }
  const btn = $("submit-followup-btn");
  btn.disabled=true; btn.textContent="Evaluating...";
  try {
    const r = await fetch(`${API}/api/followup`, {
      method:"POST", headers:{"Content-Type":"application/json"},
      body: JSON.stringify({session_id:currentSessionId, round:followupRound, questions:pendingQuestions, answers:[a1,a2]}),
    });
    const d = await r.json();
    if (!r.ok) throw new Error(d?.error?.message ?? `HTTP ${r.status}`);
    renderDrillResult(d);
  } catch(e) { showToast(`Evaluation failed: ${e.message}`, "error"); }
  finally { btn.disabled=false; btn.textContent="Submit Answers"; }
}

function renderDrillResult(data) {
  renderTags("followup-improved",   data.improved_areas);
  renderTags("followup-still-weak", data.still_weak);
  $("followup-summary").textContent = safeStr(data.summary);

  const sec = $("followup-audio-section");
  if (data.audio_base64) {
    $("followup-audio").src = `data:${data.audio_mime??"audio/mpeg"};base64,${data.audio_base64}`;
    sec.hidden = false;
  } else sec.hidden = true;

  $("followup-result").hidden       = false;
  $("more-questions-prompt").hidden = true;
  $("followup-done-msg").hidden     = true;

  if (data.suggest_more && data.next_questions?.length === 2) {
    $("more-questions-prompt").hidden = false;
    $("yes-more-btn").onclick = () => {
      $("more-questions-prompt").hidden = true;
      showDrillQuestions(data.next_questions, "Keep going!", data.round + 1);
    };
    $("no-more-btn").onclick = () => {
      $("more-questions-prompt").hidden = true;
      $("followup-done-msg").hidden = false;
      loadStats();
    };
  } else {
    $("followup-done-msg").hidden = false;
    loadStats();
  }
  $("followup-result").scrollIntoView({behavior:"smooth",block:"start"});
}

// ════════════════════════════════════════════════════════════════
//  PANEL 5 – My Stats
// ════════════════════════════════════════════════════════════════
$("open-stats-btn").addEventListener("click", loadStats);
$("hide-stats-btn").addEventListener("click", () => $("panel-stats").hidden=true);

async function loadStats() {
  try {
    const d = await fetch(`${API}/api/stats`).then(r=>r.json());
    $("stat-this-month").textContent  = d.this_month ?? 0;
    $("stat-all-time").textContent    = d.all_time   ?? 0;
    $("header-count").textContent     = d.this_month ?? 0;
    const tb = $("recent-tbody"); tb.innerHTML = "";
    (d.recent ?? []).forEach(row => {
      const tr = document.createElement("tr");
      tr.innerHTML = `
        <td>${fmtDate(row.started_at)}</td>
        <td>${row.score_percent ?? "-"}%</td>
        <td>${row.understanding_level ?? "-"}</td>
        <td>${row.language_detected ?? "-"}</td>
        <td>${row.followup_rounds ?? 0}</td>`;
      tb.appendChild(tr);
    });
    $("panel-stats").hidden = false;
    $("panel-stats").scrollIntoView({behavior:"smooth",block:"start"});
  } catch(e) { showToast(`Could not load stats: ${e}`, "error"); }
}

// ════════════════════════════════════════════════════════════════
//  PANEL 6 – Admin Dashboard
// ════════════════════════════════════════════════════════════════
$("open-dashboard-btn").addEventListener("click", loadDashboard);
$("hide-dashboard-btn").addEventListener("click", () => $("panel-dashboard").hidden=true);

// Tab switching
document.querySelectorAll(".dash-tab").forEach(btn => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".dash-tab").forEach(b => b.classList.remove("active"));
    document.querySelectorAll(".dash-tab-panel").forEach(p => p.hidden=true);
    btn.classList.add("active");
    $(`dash-tab-${btn.dataset.tab}`).hidden = false;
  });
});

async function loadDashboard() {
  try {
    const d = await fetch(`${API}/api/dashboard`).then(r=>r.json());
    if (d.error) { showToast(d.error.message, "error"); return; }

    // Summary cards
    const s = d.summary;
    $("dash-summary").innerHTML = `
      <div class="stat-card"><div class="stat-num">${s.total_users}</div><div class="stat-desc">Total Users</div></div>
      <div class="stat-card"><div class="stat-num">${s.total_logins}</div><div class="stat-desc">Total Logins</div></div>
      <div class="stat-card"><div class="stat-num">${s.total_usages}</div><div class="stat-desc">Total Sessions</div></div>
      <div class="stat-card">
        <div class="stat-num" style="font-size:1rem">${Object.entries(s.usage_by_month).sort((a,b)=>b[0].localeCompare(a[0])).slice(0,3).map(([k,v])=>`${k}: ${v}`).join("<br>")}</div>
        <div class="stat-desc">Monthly Usage</div>
      </div>`;

    // Users table
    const ut = $("dash-users-tbody"); ut.innerHTML = "";
    (d.users ?? []).forEach(u => {
      const tr = document.createElement("tr");
      tr.innerHTML = `<td>${u.email}</td><td>${u.user_name}</td>`;
      ut.appendChild(tr);
    });

    // Logins table
    const lt = $("dash-logins-tbody"); lt.innerHTML = "";
    (d.logins ?? []).slice(0,50).forEach(l => {
      const tr = document.createElement("tr");
      tr.innerHTML = `<td>${l.email}</td><td>${fmtDate(l.logged_at)}</td>`;
      lt.appendChild(tr);
    });

    // Usage table
    const ust = $("dash-usage-tbody"); ust.innerHTML = "";
    (d.usages ?? []).slice(0,50).forEach(u => {
      const tr = document.createElement("tr");
      tr.innerHTML = `<td>${u.email}</td><td>${fmtDate(u.used_at)}</td><td>${u.action}</td>`;
      ust.appendChild(tr);
    });

    // Monthly D1 counts
    const mt = $("dash-monthly-tbody"); mt.innerHTML = "";
    (d.monthly_d1 ?? []).forEach(r => {
      const tr = document.createElement("tr");
      tr.innerHTML = `<td>${r.email}</td><td>${r.year}</td><td>${r.month}</td><td>${r.count}</td>`;
      mt.appendChild(tr);
    });

    $("panel-dashboard").hidden = false;
    $("panel-dashboard").scrollIntoView({behavior:"smooth",block:"start"});
  } catch(e) { showToast(`Dashboard error: ${e}`, "error"); }
}

// Boot
boot();
