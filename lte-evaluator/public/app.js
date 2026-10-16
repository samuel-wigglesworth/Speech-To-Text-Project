"use strict";

// ─── Configuration ──────────────────────────────────────────────────────────
const API_BASE = "";

// ─── Utility ────────────────────────────────────────────────────────────────
function $(id) { return document.getElementById(id); }

function showToast(msg, type = "info") {
  const t = $("toast");
  t.textContent = msg;
  t.className = `toast toast-${type}`;
  requestAnimationFrame(() => t.classList.add("show"));
  setTimeout(() => t.classList.remove("show"), 3500);
}

function fmtBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

function fileTypeLabel(mimeType) {
  if (!mimeType) return "File";
  if (mimeType.startsWith("image/")) return "Image";
  if (mimeType.startsWith("audio/")) return "Audio";
  if (mimeType.startsWith("video/")) return "Video";
  if (mimeType === "application/pdf") return "PDF";
  return "Text";
}

/**
 * Safely coerce a value to a display string.
 * Prevents [object Object] from appearing in the UI.
 */
function safeStr(val, fallback = "-") {
  if (val === null || val === undefined) return fallback;
  if (typeof val === "string") return val.trim() || fallback;
  if (typeof val === "number") return String(val);
  // Object — try to extract a useful string
  try { return JSON.stringify(val); } catch { return fallback; }
}

// ─── Drag & Drop helper ──────────────────────────────────────────────────────
function makeDraggable(zone, onDrop) {
  zone.addEventListener("dragover", (e) => { e.preventDefault(); zone.classList.add("drag-over"); });
  zone.addEventListener("dragleave", () => zone.classList.remove("drag-over"));
  zone.addEventListener("drop", (e) => {
    e.preventDefault();
    zone.classList.remove("drag-over");
    const files = Array.from(e.dataTransfer.files);
    if (files.length) onDrop(files);
  });
  zone.addEventListener("click", (e) => {
    if (e.target.tagName === "BUTTON") return;
    zone.querySelector("input[type=file]")?.click();
  });
  zone.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      zone.querySelector("input[type=file]")?.click();
    }
  });
}

// ════════════════════════════════════════════════════════════════
//  PANEL 1 – Content Upload
// ════════════════════════════════════════════════════════════════
let contentFiles = [];

const contentDropZone  = $("content-drop-zone");
const contentFileInput = $("content-file-input");
const contentFileList  = $("content-file-list");
const contentUploadBtn = $("content-upload-btn");
const contentResult    = $("content-result");

makeDraggable(contentDropZone, addContentFiles);

$("content-file-btn").addEventListener("click", () => contentFileInput.click());
contentFileInput.addEventListener("change", () => {
  addContentFiles(Array.from(contentFileInput.files));
  contentFileInput.value = "";
});

function addContentFiles(files) {
  contentFiles.push(...files);
  renderContentFileList();
}

function renderContentFileList() {
  contentFileList.innerHTML = "";
  contentFiles.forEach((f, i) => {
    const li = document.createElement("li");
    li.innerHTML = `
      <span class="file-icon">${fileTypeLabel(f.type)}</span>
      <span class="file-name" title="${f.name}">${f.name}</span>
      <span class="file-size">${fmtBytes(f.size)}</span>
      <button class="remove-file" aria-label="Remove ${f.name}" data-idx="${i}">&times;</button>
    `;
    contentFileList.appendChild(li);
  });
  contentFileList.querySelectorAll(".remove-file").forEach(btn => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      contentFiles.splice(Number(btn.dataset.idx), 1);
      renderContentFileList();
    });
  });
  contentUploadBtn.disabled = contentFiles.length === 0;
}

contentUploadBtn.addEventListener("click", uploadContentFiles);

async function uploadContentFiles() {
  if (!contentFiles.length) return;
  contentUploadBtn.disabled = true;
  contentUploadBtn.textContent = "Uploading...";
  contentResult.hidden = false;
  contentResult.textContent = "";

  const results = [];
  for (const file of contentFiles) {
    const form = new FormData();
    const key  = file.name.replace(/[^a-z0-9._-]/gi, "-").toLowerCase();
    form.append("key",   key);
    form.append("title", file.name);
    form.append("type",  file.type.split("/")[0] || "text");
    form.append("file",  file);

    try {
      const res  = await fetch(`${API_BASE}/api/content/upload`, { method: "POST", body: form });
      const data = await res.json();
      results.push({ file: file.name, ...data });
    } catch (e) {
      results.push({ file: file.name, error: String(e) });
    }
  }

  contentResult.textContent = JSON.stringify(results, null, 2);
  contentFiles = [];
  renderContentFileList();
  contentUploadBtn.textContent = "Upload Selected Files";
  contentUploadBtn.disabled = true;
  showToast("Content uploaded successfully.", "success");
}

// ── Manual text upload ───────────────────────────────────────────────────────
$("manual-upload-btn").addEventListener("click", async () => {
  const key     = $("manual-key").value.trim()     || `content-${Date.now()}`;
  const title   = $("manual-title").value.trim()   || key;
  const content = $("manual-content").value.trim();
  if (!content) { showToast("Please enter some content text.", "error"); return; }

  const btn = $("manual-upload-btn");
  btn.disabled    = true;
  btn.textContent = "Uploading...";

  try {
    const res  = await fetch(`${API_BASE}/api/content/upload`, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ key, title, type: "text", content }),
    });
    const data = await res.json();
    contentResult.hidden    = false;
    contentResult.textContent = JSON.stringify(data, null, 2);
    $("manual-key").value     = "";
    $("manual-title").value   = "";
    $("manual-content").value = "";
    showToast(`Content "${key}" uploaded.`, "success");
  } catch (e) {
    showToast(`Upload failed: ${e}`, "error");
  } finally {
    btn.disabled    = false;
    btn.textContent = "Upload Text Content";
  }
});

// ── Stored content modal ─────────────────────────────────────────────────────
function openModal()  { $("content-modal-overlay").classList.add("is-open"); }
function closeModal() { $("content-modal-overlay").classList.remove("is-open"); }

$("content-list-btn").addEventListener("click", openContentModal);
$("modal-close-btn").addEventListener("click", closeModal);
$("content-modal-overlay").addEventListener("click", (e) => {
  if (e.target === $("content-modal-overlay")) closeModal();
});

async function openContentModal() {
  openModal();
  const list = $("stored-keys-list");
  list.innerHTML = "<li style='color:var(--text-muted);font-size:.85rem'>Loading...</li>";
  $("no-keys-msg").hidden = true;

  try {
    const res  = await fetch(`${API_BASE}/api/content/list`);
    const data = await res.json();
    list.innerHTML = "";
    if (!data.keys?.length) {
      $("no-keys-msg").hidden = false;
      return;
    }
    data.keys.forEach(k => {
      const li = document.createElement("li");
      li.innerHTML = `
        <span class="key-name">${k.name}</span>
        <span class="key-type">${k.metadata?.type ?? "-"}</span>
      `;
      li.addEventListener("click", () => {
        $("eval-content-key").value = k.name;
        closeModal();
        showToast(`Selected "${k.name}" for evaluation.`, "info");
      });
      list.appendChild(li);
    });
  } catch (e) {
    list.innerHTML = `<li style='color:var(--danger)'>Error loading keys: ${e}</li>`;
  }
}

$("refresh-keys-btn").addEventListener("click", async () => {
  try {
    const res  = await fetch(`${API_BASE}/api/content/list`);
    const data = await res.json();
    if (data.keys?.length) {
      showToast(`${data.keys.length} content item(s) available.`, "info");
    } else {
      showToast("No content stored yet. Upload content first.", "info");
    }
  } catch (e) {
    showToast(`Failed to fetch keys: ${e}`, "error");
  }
});

// ════════════════════════════════════════════════════════════════
//  PANEL 2 – Learner Audio Input
// ════════════════════════════════════════════════════════════════
let selectedAudioBlob = null;
let selectedAudioFile = null;

const audioDropZone  = $("audio-drop-zone");
const audioFileInput = $("audio-file-input");
const evaluateBtn    = $("evaluate-btn");

makeDraggable(audioDropZone, (files) => setAudioFile(files[0]));
$("audio-file-btn").addEventListener("click", () => audioFileInput.click());
audioFileInput.addEventListener("change", () => {
  if (audioFileInput.files[0]) setAudioFile(audioFileInput.files[0]);
  audioFileInput.value = "";
});

function setAudioFile(file) {
  if (!file.type.startsWith("audio/")) {
    showToast("Please select an audio file (MP3, WAV, WebM, OGG).", "error");
    return;
  }
  if (file.size > 2 * 1024 * 1024) {
    showToast("Audio file must be 2 MB or less.", "error");
    return;
  }
  selectedAudioFile = file;
  selectedAudioBlob = null;
  showSelectedAudio(`File: ${file.name} (${fmtBytes(file.size)})`);
}

function showSelectedAudio(label) {
  const el     = $("selected-audio-label");
  el.textContent = label;
  el.hidden      = false;
  evaluateBtn.disabled = false;
}

// ── Recorder ─────────────────────────────────────────────────────────────────
let mediaRecorder    = null;
let recChunks        = [];
let recTimerInterval = null;
let recSeconds       = 0;

$("rec-start-btn").addEventListener("click", startRecording);
$("rec-stop-btn").addEventListener("click", stopRecording);

async function startRecording() {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    recChunks    = [];
    mediaRecorder = new MediaRecorder(stream, { mimeType: "audio/webm" });
    mediaRecorder.ondataavailable = (e) => { if (e.data.size > 0) recChunks.push(e.data); };
    mediaRecorder.onstop = onRecordingStop;
    mediaRecorder.start(100);

    $("rec-start-btn").disabled  = true;
    $("rec-stop-btn").disabled   = false;
    $("rec-status").textContent  = "Recording...";
    recSeconds = 0;
    $("rec-timer").textContent   = "0:00";
    recTimerInterval = setInterval(() => {
      recSeconds++;
      const m = Math.floor(recSeconds / 60);
      const s = String(recSeconds % 60).padStart(2, "0");
      $("rec-timer").textContent = `${m}:${s}`;
      if (recSeconds >= 90) stopRecording();
    }, 1000);
  } catch (e) {
    showToast(`Microphone access denied: ${e.message}`, "error");
  }
}

function stopRecording() {
  if (mediaRecorder && mediaRecorder.state !== "inactive") {
    mediaRecorder.stop();
    mediaRecorder.stream.getTracks().forEach(t => t.stop());
  }
  clearInterval(recTimerInterval);
  $("rec-start-btn").disabled = false;
  $("rec-stop-btn").disabled  = true;
  $("rec-status").textContent = "Recording stopped.";
}

function onRecordingStop() {
  const blob = new Blob(recChunks, { type: "audio/webm" });
  if (blob.size > 2 * 1024 * 1024) {
    showToast("Recording too large (over 2 MB). Please record a shorter clip.", "error");
    return;
  }
  selectedAudioBlob = blob;
  selectedAudioFile = null;

  const url     = URL.createObjectURL(blob);
  const playback = $("rec-playback");
  playback.src   = url;
  playback.hidden = false;
  showSelectedAudio(`Recorded audio (${fmtBytes(blob.size)})`);
}

// ════════════════════════════════════════════════════════════════
//  EVALUATION PIPELINE
// ════════════════════════════════════════════════════════════════
evaluateBtn.addEventListener("click", runEvaluation);

async function runEvaluation() {
  const audio = selectedAudioBlob
    ? new File([selectedAudioBlob], "recording.webm", { type: "audio/webm" })
    : selectedAudioFile;

  if (!audio) { showToast("Please record or select audio first.", "error"); return; }

  evaluateBtn.disabled    = true;
  evaluateBtn.textContent = "Evaluating...";
  $("progress-steps").hidden = false;
  $("panel-results").hidden  = true;

  // Set all steps to pending initially
  setStep("transcribe", "active");
  setStep("evaluate",   "pending");
  setStep("speak",      "pending");

  const langHint   = $("lang-hint").value;
  const contentKey = $("eval-content-key").value.trim();

  const form = new FormData();
  form.append("audio", audio);
  if (langHint)   form.append("language_hint", langHint);
  if (contentKey) form.append("content_keys",  contentKey);
  form.append("return_audio", "true");

  try {
    // The server does all three steps (transcribe→evaluate→speak) in sequence.
    // We advance the UI indicators at plausible intervals while waiting.
    const stepTimer = setTimeout(() => setStep("evaluate", "active"), 3000);

    const res = await fetch(`${API_BASE}/api/full-eval`, { method: "POST", body: form });
    clearTimeout(stepTimer);

    if (!res.ok) {
      // Parse the error body — it may be JSON or a Cloudflare HTML error page
      let errMsg = `Server error (HTTP ${res.status})`;
      try {
        const errData = await res.json();
        errMsg = errData?.error?.message ?? errMsg;
      } catch {
        // Non-JSON body (e.g. Cloudflare 1101 HTML page)
        const text = await res.text().catch(() => "");
        if (text.includes("1101")) {
          errMsg = "Workers AI is currently unavailable or taking too long. Please try again in a moment.";
        }
      }
      throw new Error(errMsg);
    }

    setStep("evaluate", "done");
    setStep("transcribe", "done");
    setStep("speak", "active");

    const data = await res.json();

    setStep("speak", data.audio_base64 ? "done" : "pending");

    await delay(300);
    renderResults(data);

  } catch (e) {
    showToast(e.message, "error");
    setStep("transcribe", "pending");
    setStep("evaluate",   "pending");
    setStep("speak",      "pending");
  } finally {
    evaluateBtn.disabled    = false;
    evaluateBtn.textContent = "Evaluate My Understanding";
  }
}

// ─── Progress step state ─────────────────────────────────────────────────────
const STEP_LABELS = {
  transcribe: { pending: "Transcribing your speech...",       active: "Transcribing your speech...",  done: "Transcription complete" },
  evaluate:   { pending: "Analysing your understanding...",   active: "Analysing your understanding...", done: "Analysis complete" },
  speak:      { pending: "Generating audio feedback...",      active: "Generating audio feedback...", done: "Audio feedback ready" },
};

function setStep(name, state) {
  const el = $(`step-${name}`);
  if (!el) return;
  el.textContent = STEP_LABELS[name][state] ?? STEP_LABELS[name].pending;
  el.className   = `step ${state}`;
}

// ─── Render results ──────────────────────────────────────────────────────────
function renderResults(data) {
  const ev    = data.evaluation ?? {};
  const score = Number(ev.score_percent ?? 0);
  const level = safeStr(ev.understanding_level, "Unknown");

  // Score bar (animate on next frame)
  setTimeout(() => {
    $("score-bar").style.width    = `${score}%`;
    $("score-value").textContent  = `${score}%`;
  }, 100);
  $("understanding-badge").textContent = level;

  // Transcript
  $("result-transcript").textContent = safeStr(data.transcript ?? ev.transcript_summary);
  $("result-lang").textContent       = safeStr(data.language_detected ?? ev.language_detected);

  // Tag lists
  renderTagList("result-strong",  ev.strong_areas);
  renderTagList("result-weak",    ev.weak_areas);
  renderTagList("result-missing", ev.missing_concepts);

  // Conclusion — use safeStr to prevent [object Object]
  // Prefer ev.conclusion; fall back to raw_response if parse failed; then "-"
  const conclusionText = safeStr(ev.conclusion) !== "-"
    ? safeStr(ev.conclusion)
    : safeStr(ev.raw_response);
  $("result-conclusion").textContent = conclusionText;

  // Audio feedback
  const audioSection = $("audio-feedback-section");
  if (data.audio_base64) {
    const audioEl  = $("feedback-audio");
    const mime     = safeStr(data.audio_mime, "audio/mpeg");
    audioEl.src    = `data:${mime};base64,${data.audio_base64}`;
    audioSection.hidden = false;

    $("download-audio-btn").onclick = () => {
      const a    = document.createElement("a");
      a.href     = audioEl.src;
      a.download = "lte-feedback.mp3";
      a.click();
    };
  } else {
    audioSection.hidden = true;
  }

  $("panel-results").hidden = false;
  $("panel-results").scrollIntoView({ behavior: "smooth", block: "start" });
}

function renderTagList(id, items) {
  const ul = $(id);
  ul.innerHTML = "";
  if (!Array.isArray(items) || !items.length) {
    ul.classList.add("empty");
    return;
  }
  ul.classList.remove("empty");
  items.forEach(item => {
    const li       = document.createElement("li");
    li.textContent = safeStr(item);
    ul.appendChild(li);
  });
}

// ── Try again ────────────────────────────────────────────────────────────────
$("try-again-btn").addEventListener("click", () => {
  $("panel-results").hidden        = true;
  $("progress-steps").hidden       = true;
  $("selected-audio-label").hidden = true;
  selectedAudioBlob = null;
  selectedAudioFile = null;
  evaluateBtn.disabled = true;

  const playback  = $("rec-playback");
  playback.hidden = true;
  playback.src    = "";

  $("rec-status").textContent = "Ready to record";
  $("rec-timer").textContent  = "0:00";
  $("panel-evaluate").scrollIntoView({ behavior: "smooth", block: "start" });
});

// ─── Utility ─────────────────────────────────────────────────────────────────
function delay(ms) { return new Promise(r => setTimeout(r, ms)); }
