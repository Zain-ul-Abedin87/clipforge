// ClipForge simple UI: Create -> Progress/Result, My videos, Settings. Talks to the existing /api.
const $ = (s) => document.querySelector(s);
const api = async (url, opts = {}) => {
  const r = await fetch(url, opts);
  const ct = r.headers.get("content-type") || "";
  const body = ct.includes("json") ? await r.json() : await r.text();
  if (!r.ok) throw new Error((body && body.error) || r.statusText);
  return body;
};
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
// [key, label, share of total time (rough, footage dominates)]
const STEPS = [
  ["voice", "Voice", 3], ["transcribe", "Transcribe", 8], ["plan", "Plan", 7], ["assets", "Footage", 45],
  ["timeline", "Timeline", 4], ["render", "Render", 28], ["qa", "QA", 5],
];
const STEP_KEY = { transcribe: "transcribe", align: "transcribe", plan: "plan", assets: "assets", timeline: "timeline", render: "render", qa: "qa" };
const STATE_TXT = { skip: "Not needed", done: "Done", running: "Working", failed: "Failed", pending: "Waiting" };
let settings = null;
let audioFile = null;
let niche = "guns";
let poll = null;

/**
 * POST a file with progress. Header values are URI-encoded (the server decodes them). Resolves with
 * the parsed JSON reply ({} when there is none).
 */
function uploadFile(url, file, headers = {}, onProgress = () => {}) {
  return new Promise((resolve, reject) => {
    const x = new XMLHttpRequest();
    x.open("POST", url);
    for (const [k, v] of Object.entries(headers)) x.setRequestHeader(k, encodeURIComponent(v));
    x.upload.onprogress = (e) => e.lengthComputable && onProgress(e.loaded / e.total);
    const reply = () => { try { return JSON.parse(x.responseText); } catch { return {}; } };
    x.onload = () => (x.status < 300 ? resolve(reply()) : reject(new Error(reply().error || x.statusText)));
    x.onerror = () => reject(new Error("upload failed"));
    x.send(file);
  });
}

function setToggle(el, v) { el.querySelectorAll("button").forEach((b) => b.classList.toggle("on", b.dataset.v === v)); }
function onToggle(el, fn) { el.addEventListener("click", (e) => { const b = e.target.closest("button"); if (b) { setToggle(el, b.dataset.v); fn(b.dataset.v); } }); }
const fmtDur = (ms) => { const s = Math.max(0, Math.round(ms / 1000)); const m = Math.floor(s / 60); return m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : m ? `${m}m ${String(s % 60).padStart(2, "0")}s` : `${s}s`; };

// ---------- router ----------
function route() {
  clearInterval(poll);
  document.querySelector("main").classList.remove("wide");
  if (window.Studio?.project) Studio.close();
  studio.name = null;
  const [, page, arg] = (location.hash || "#/create").split("/");
  document.querySelectorAll(".page").forEach((p) => (p.hidden = true));
  document.querySelectorAll("nav a[data-nav]").forEach((a) => a.classList.toggle("active", a.dataset.nav === (page === "project" ? "videos" : page || "create")));
  if (page === "project" && arg) return showProject(decodeURIComponent(arg));
  if (page === "videos") return showVideos();
  if (page === "settings") return showSettings();
  if (page === "library") return window.showLibrary?.();
  $("#page-create").hidden = false;
}
window.addEventListener("hashchange", route);

// ---------- create ----------
function mode() {
  const s = $("#script").value.trim();
  return audioFile && s ? "both" : audioFile ? "voice" : s ? "tts" : null;
}
function refreshModes() {
  const m = mode();
  $("#mode-note").textContent = m === "both" ? "Script + voiceover: best timing." : m === "voice" ? "Voiceover only: words are transcribed." : m === "tts" ? "Script only: computer voice reads it (set TTS_PROVIDER in .env for ElevenLabs / OpenAI / Piper)." : "No voiceover? The computer voice reads the script.";
  const n = $("#script").value.trim().split(/\s+/).filter(Boolean).length;
  $("#wordcount").textContent = `${n} words` + (n ? ` \u00b7 about ${Math.max(1, Math.round(n / 150))} min of narration` : "");
}
function setAudio(f) {
  audioFile = f;
  $("#drop").classList.toggle("has", !!f);
  $("#drop-text").textContent = f ? `${f.name} (${(f.size / 1048576).toFixed(1)} MB)` : "Click or drop your voiceover file here";
  $("#clear-audio").hidden = !f;
  refreshModes();
}
$("#audio").addEventListener("change", (e) => setAudio(e.target.files[0] || null));
$("#clear-audio").addEventListener("click", () => { $("#audio").value = ""; setAudio(null); });
const drop = $("#drop");
drop.addEventListener("dragover", (e) => { e.preventDefault(); drop.classList.add("over"); });
drop.addEventListener("dragleave", () => drop.classList.remove("over"));
drop.addEventListener("drop", (e) => { e.preventDefault(); drop.classList.remove("over"); if (e.dataTransfer.files[0]) setAudio(e.dataTransfer.files[0]); });
$("#script").addEventListener("input", refreshModes);
const slugify = (t) => t.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 48);
async function loadChannels() {
  const list = await api("/api/channels").catch(() => []);
  // Prefer "auto" first in the list so it is the default selected preset.
  const ordered = [...list].sort((a, b) => (a.name === "auto" ? -1 : b.name === "auto" ? 1 : a.name.localeCompare(b.name)));
  const opts = ordered.map((c) => `<option value="${esc(c.name)}">${esc(c.name)}${c.style && c.style.niche ? ` (${esc(c.style.niche)})` : ""}</option>`).join("");
  $("#channel").innerHTML = opts || '<option value="auto">auto (auto)</option>';
  if (ordered.some((c) => c.name === "auto")) $("#channel").value = "auto";
  return ordered;
}

// ---------- background music (Create page) ----------
// "default" follows the channel, "off" = none, "track:<file>" = one track of the channel's library.
async function refreshMusicOptions(select) {
  const channel = $("#channel").value || "default";
  const tracks = await api(`/api/channels/${encodeURIComponent(channel)}/music`).catch(() => []);
  const want = select ?? $("#music").value;
  $("#music").innerHTML = '<option value="default">Channel default</option><option value="off">No music</option>'
    + tracks.map((t) => `<option value="track:${esc(t.name)}">${esc(t.name)}</option>`).join("");
  $("#music").value = [...$("#music").options].some((o) => o.value === want) ? want : "default";
}
function musicChoice() {
  const v = $("#music").value;
  return v.startsWith("track:") ? { mode: "track", track: v.slice(6) } : { mode: v };
}
$("#channel").addEventListener("change", () => refreshMusicOptions());
$("#music-add").addEventListener("click", () => { $("#music-upload").hidden = !$("#music-upload").hidden; });
$("#music-send").addEventListener("click", async () => {
  const file = $("#music-file").files[0];
  const note = $("#music-note").value.trim();
  const msg = $("#music-msg");
  msg.textContent = "";
  if (!file) return (msg.textContent = "Choose an audio file first.");
  if (!note) return (msg.textContent = "Enter where the track comes from (source or licence).");
  const btn = $("#music-send");
  btn.disabled = true;
  try {
    const r = await uploadFile(`/api/channels/${encodeURIComponent($("#channel").value || "default")}/music`, file, { "x-filename": file.name, "x-note": note }, (p) => (msg.textContent = `Uploading ${Math.round(p * 100)}%`));
    await refreshMusicOptions(`track:${r.name}`);
    $("#music-file").value = "";
    $("#music-note").value = "";
    $("#music-upload").hidden = true;
    msg.textContent = "";
  } catch (e) {
    msg.textContent = e.message;
  } finally {
    btn.disabled = false;
  }
});

$("#go").addEventListener("click", async () => {
  const err = $("#create-error");
  err.textContent = "";
  const title = $("#title").value.trim();
  const d = new Date();
  const stamp = `${d.getMonth() + 1}${String(d.getDate()).padStart(2, "0")}-${String(d.getHours()).padStart(2, "0")}${String(d.getMinutes()).padStart(2, "0")}`;
  const name = `${slugify(title || ($("#script").value.trim().split(/\s+/).slice(0, 5).join(" ")) || "video") || "video"}-${stamp}`;
  if (!mode()) return (err.textContent = "Paste a script or upload a voiceover (or both).");
  const btn = $("#go");
  btn.disabled = true;
  try {
    if (audioFile) {
      btn.textContent = "Uploading voiceover...";
      await api(`/api/projects/${name}/audio`, { method: "POST", headers: { "x-filename": audioFile.name }, body: audioFile });
    }
    btn.textContent = "Starting...";
    await api(`/api/projects/${name}/go`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ script: $("#script").value, title, channel: $("#channel").value, review: $("#review").checked, music: musicChoice() }) });
    location.hash = `#/project/${name}`;
  } catch (e) {
    err.textContent = e.message;
  } finally {
    btn.disabled = false;
    btn.textContent = "Go";
  }
});

// ---------- progress + result ----------
// While a job runs, the server's per-step status is "done" whenever an output file from an EARLIER run
// exists, so a re-run showed Render/QA (step 7) as done. Here the running job's current step is the
// source of truth: before it = done, it = running, after it = pending.
function stepStates(j, tts) {
  const st = j.steps || {};
  const voiceKind = tts ? null : "skip";
  if (j.running) {
    const curKey = j.step ? STEP_KEY[j.step] : tts ? "voice" : "transcribe";
    const ci = STEPS.findIndex(([k]) => k === curKey);
    const out = {};
    STEPS.forEach(([k], i) => { out[k] = k === "voice" && !tts ? "skip" : i < ci ? "done" : i === ci ? "running" : "pending"; });
    return out;
  }
  const merged = (a, b) => (a === "failed" || b === "failed" ? "failed" : a === "done" && b === "done" ? "done" : "pending");
  const fk = j.failedStep ? STEP_KEY[j.failedStep] : null;
  const fi = fk ? STEPS.findIndex(([k]) => k === fk) : -1;
  const out = {
    voice: voiceKind || (fk === "transcribe" && st.transcribe !== "done" ? "failed" : st.transcribe === "done" ? "done" : "pending"),
    transcribe: merged(st.transcribe, st.align), plan: st.plan, assets: st.assets, timeline: st.timeline, render: st.render, qa: st.qa,
  };
  if (fi >= 0) STEPS.forEach(([k], i) => { if (i > fi && k !== "voice") out[k] = "pending"; if (i === fi) out[k] = "failed"; });
  for (const k in out) if (!STATE_TXT[out[k]]) out[k] = "pending";
  return out;
}
// Fraction of the current step from the latest "12/40" or "45%" in its log lines.
function stepFraction(logText) {
  const tail = logText.slice(logText.lastIndexOf("=== ")).split("\n").slice(-30).reverse();
  for (const l of tail) {
    const p = l.match(/(\d{1,3}(?:\.\d+)?)\s*%/);
    if (p && +p[1] <= 100) return +p[1] / 100;
    const f = l.match(/\b(\d+)\s*\/\s*(\d+)\b/);
    if (f && +f[2] > 0 && +f[1] <= +f[2]) return +f[1] / +f[2];
  }
  return 0.1;
}

const fmtT = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
// ---------- studio: one page from "cooking" to the finished video ----------
// cooking  : pipeline before the timeline exists -> storyboard fills in, live footage feed, cooking stage
// editing  : timeline exists -> CapCut-style editor (studio.js) with live preview, Render button
// rendering: render / QA running -> editor stays visible, edits wait
// done     : final MP4 in "Final video" tab, QA + publish pack below
const COOK_TEXT = {
  voice: ["Generating the voiceover", "Reading the script aloud"],
  transcribe: ["Transcribing the voiceover", "Timing every word"],
  plan: ["Planning the scenes", "Splitting the script into scenes"],
  assets: ["Finding footage", "Exact-model footage for each product from YouTube and official sites"],
  timeline: ["Building the timeline", "Syncing clips, cards and sound effects to the voiceover"],
  render: ["Rendering the video", "Encoding the MP4"],
  qa: ["Running quality checks", "Checking sync, black frames and repeated shots"],
};
const studio = { name: null, mode: null, story: null, storyAt: 0, sel: null, view: "edit" };

function setStudioMode(mode) {
  if (studio.mode === mode) return;
  studio.mode = mode;
  const editing = mode === "editing" || mode === "rendering" || mode === "done";
  $("#st-editor").hidden = !editing;
  $("#st-transport").hidden = !editing;
  $("#st-editside").hidden = !editing;
  $("#st-feed").hidden = editing;
  $("#st-story").hidden = editing;
  $("#st-cook").hidden = editing;
  $("#edRender").disabled = mode !== "editing" && mode !== "done";
  $("#st-viewtabs").hidden = mode !== "done";
  if (mode !== "done") setView("edit");
}

function setView(v) {
  studio.view = v;
  setToggle($("#st-viewtabs"), v);
  const fin = v === "final";
  $("#edStage").hidden = fin;
  $("#player").hidden = !fin;
  $("#st-transport").hidden = fin || !["editing", "rendering", "done"].includes(studio.mode);
  if (fin) window.Studio?.pause();
  else $("#player").pause();
}
onToggle($("#st-viewtabs"), setView);

/** Cooking stage: the newest footage behind a "what is happening" card. */
function cookStage(stepKey) {
  const [title, sub] = COOK_TEXT[stepKey] || ["Starting", ""];
  $("#st-cook-title").textContent = title;
  $("#st-cook-sub").textContent = sub;
  const sb = studio.story;
  const pic = sb?.feed?.[0]?.url || [...(sb?.scenes || [])].reverse().find((s) => s.thumb)?.thumb;
  let bg = $("#st-cook").querySelector(".st-cookbg");
  if (pic) {
    if (!bg) { bg = document.createElement("img"); bg.className = "st-cookbg"; $("#st-cook").prepend(bg); }
    if (bg.dataset.src !== pic) { bg.src = pic; bg.dataset.src = pic; }
  }
}

async function refreshStory(name, force = false) {
  if (!force && Date.now() - studio.storyAt < 4000) return;
  studio.storyAt = Date.now();
  const sb = await api(`/api/projects/${encodeURIComponent(name)}/storyboard`).catch(() => null);
  if (!sb || studio.name !== name) return;
  studio.story = sb;
  const ready = sb.scenes.filter((s) => s.thumb).length;
  $("#st-story-note").textContent = sb.scenes.length ? `${sb.scenes.length} scenes · footage ready for ${ready}` : "Scenes appear here once the plan is ready.";
  $("#st-strip").innerHTML = sb.scenes.map((s) => `<div class="st-sc${studio.sel === s.id ? " on" : ""}" data-sc="${s.id}">
      ${s.thumb ? `<img loading="lazy" src="${esc(s.thumb)}" alt="">` : `<div class="ph">${s.type === "graphic" ? "card" : "footage..."}</div>`}
      <div class="tx"><span class="tg">#${s.id} · ${fmtT(s.start)}</span>${s.product ? `<span class="tg">${esc(s.product)}</span>` : ""}${esc(s.text)}</div></div>`).join("");
  $("#st-feed-grid").innerHTML = sb.feed.slice(0, 12).map((f) => `<figure><img src="${esc(f.url)}" alt=""><figcaption>${esc(f.product)}</figcaption></figure>`).join("");
  $("#st-feed-note").innerHTML = sb.products.length
    ? sb.products.map((p) => `<div class="st-prod"><span>${esc(p.name)}</span><b>${p.clips} clips</b></div>`).join("")
    : "Footage appears here as soon as it is found.";
}
$("#st-strip").addEventListener("click", (e) => {
  const c = e.target.closest("[data-sc]");
  if (!c || !studio.story) return;
  studio.sel = Number(c.dataset.sc);
  const s = studio.story.scenes.find((x) => x.id === studio.sel);
  document.querySelectorAll(".st-sc").forEach((el) => el.classList.toggle("on", el === c));
  if (s?.thumb) {
    let bg = $("#st-cook").querySelector(".st-cookbg");
    if (!bg) { bg = document.createElement("img"); bg.className = "st-cookbg"; $("#st-cook").prepend(bg); }
    bg.src = s.thumb; bg.dataset.src = s.thumb;
  }
  $("#edSceneText").textContent = s ? `#${s.id}: ${s.text}` : "";
});

window.onStudioRender = () => { if (studio.name) showProject(studio.name, true); };

async function showProject(name, keep = false) {
  clearInterval(poll);
  $("#page-project").hidden = false;
  document.querySelector("main").classList.add("wide");
  if (!keep || studio.name !== name) {
    studio.name = name; studio.mode = null; studio.story = null; studio.storyAt = 0; studio.sel = null;
    $("#p-title").textContent = name;
    $("#result").hidden = true;
    $("#download").hidden = true;
    $("#st-strip").innerHTML = "";
    $("#st-feed-grid").innerHTML = "";
    $("#st-cook").querySelector(".st-cookbg")?.remove();
    $("#log").textContent = "";
    setStudioMode("cooking");
  }
  let since = 0;
  let firstSeen = null;
  let opened = false;
  const logEl = $("#log");
  logEl.textContent = "";
  const proj = await api(`/api/projects/${name}`).catch(() => null);
  const tick = async () => {
    const j = await api(`/api/projects/${name}/log?since=${since}`).catch(() => null);
    if (!j || studio.name !== name) return;
    since = j.total;
    if (j.lines.length) { logEl.textContent += j.lines.join("\n") + "\n"; logEl.scrollTop = logEl.scrollHeight; }
    const tts = proj?.voiceMode === "tts" || /=== voice ===/.test(logEl.textContent);
    const state = stepStates(j, tts);
    $("#steps").innerHTML = STEPS.map(([k, label], i) => {
      const s = state[k];
      const ic = s === "done" ? "&#10003;" : s === "failed" ? "!" : s === "skip" ? "&ndash;" : String(i + 1);
      return `<li class="${s}"><span class="ic">${ic}</span>${label}</li>`;
    }).join("");

    const active = STEPS.filter(([k]) => state[k] !== "skip");
    const total = active.reduce((a, [, , w]) => a + w, 0);
    let got = 0;
    for (const [k, , w] of active) { if (state[k] === "done") got += w; else if (state[k] === "running") got += w * Math.min(0.95, stepFraction(logEl.textContent)); }
    const allDone = !j.running && state.qa === "done" && state.render === "done";
    const pct = allDone ? 100 : Math.round((got / total) * 100);
    $("#p-fill").style.width = pct + "%";
    $("#p-fill").className = "fill" + (allDone ? " done" : !j.running && j.failedStep ? " failed" : "");
    $("#p-pct").textContent = pct + "%";
    $("#st-progress").hidden = allDone;

    const cur = STEPS.find(([k]) => state[k] === "running");
    if (j.running) {
      firstSeen ??= { t: Date.now(), pct };
      const el = Date.now() - firstSeen.t, dp = pct - firstSeen.pct;
      const eta = el > 20000 && dp > 2 ? (el / dp) * (100 - pct) : null;
      $("#p-eta").textContent = `Step ${STEPS.indexOf(cur) + 1} of ${STEPS.length}: ${cur ? cur[1] : "starting"}` + (eta ? ` · about ${fmtDur(eta)} left` : "");
    } else $("#p-eta").textContent = "";

    const hasTimeline = state.timeline === "done";
    const rendering = j.running && (cur?.[0] === "render" || cur?.[0] === "qa");
    const mode = !hasTimeline || (j.running && !rendering) ? "cooking" : rendering ? "rendering" : state.render === "done" && !j.awaitingReview ? "done" : "editing";
    setStudioMode(mode);
    if (mode === "cooking") {
      cookStage(cur?.[0]);
      await refreshStory(name);
    } else if (!opened) {
      opened = await Studio.open(name);
    }
    $("#p-status").textContent = j.failedStep ? `Stopped at ${j.failedStep}. See "Technical log" below.`
      : mode === "cooking" ? `Making your video: ${cur ? cur[1] : "starting"}... scenes appear below as they are ready.`
      : mode === "rendering" ? "Rendering... you can keep reviewing; new edits apply after this render."
      : mode === "editing" ? "Scenes are ready. Play the preview, make any changes, then press Render video."
      : "Your video is ready. Watch it in the Final video tab, or edit and render again.";
    if (!j.running) {
      clearInterval(poll);
      if (mode === "done") showResult(name);
    }
  };
  await tick();
  poll = setInterval(tick, 2500);
}

async function showPublish(name) {
  const p = await api(`/api/projects/${name}/publish`).catch(() => null);
  $("#publish-card").hidden = !p;
  if (!p) return;
  $("#pub-title").value = p.title;
  $("#pub-desc").value = p.description;
  $("#pub-chap").textContent = p.chapters || "(less than 3 chapters)";
  $("#pub-thumbs").innerHTML = p.thumbnails.map((t) => `<a href="/api/projects/${name}/publish/${t}" download><img src="/api/projects/${name}/publish/${t}?t=${Date.now()}"></a>`).join("") || "<span class='help'>No thumbnails.</span>";
}

async function showResult(name) {
  $("#result").hidden = false;
  $("#download").hidden = false;
  showPublish(name);
  $("#player").src = `/api/projects/${name}/video?t=${Date.now()}`;
  $("#download").href = `/api/projects/${name}/video?download=1`;
  $("#license").href = `/api/projects/${name}/license`;
  const qa = await api(`/api/projects/${name}/file/qa_report.json`).catch(() => null);
  if (qa) {
    $("#qa-sum").innerHTML = `<span class="pill p">${qa.summary.pass} pass</span><span class="pill w">${qa.summary.warn} warnings</span><span class="pill f">${qa.summary.fail} fail</span>`;
    $("#qa-list").innerHTML = qa.checks.filter((c) => c.status !== "pass").map((c) => `<li><span class="st ${c.status}">${c.status.toUpperCase()}</span><b>${esc(c.group)}: ${esc(c.name)}</b><br><small>${esc(String(c.detail).slice(0, 400))}</small></li>`).join("") || "<li>All checks passed.</li>";
  } else $("#qa-sum").textContent = "QA has not run yet.";
}

// ---------- videos ----------
async function showVideos() {
  $("#page-videos").hidden = false;
  const list = await api("/api/projects").catch(() => []);
  $("#vlist").innerHTML = list.map((p) => {
    const steps = p.steps || {};
    const [cls, txt] = p.running ? ["working", "Working"] : Object.values(steps).includes("failed") ? ["failed", "Failed"] : steps.qa === "done" ? ["ready", "Ready"] : ["", "Draft"];
    return `<li><a href="#/project/${encodeURIComponent(p.name)}">${esc(p.name)}</a><span class="vmeta">${esc(p.niche || "")}<span class="badge ${cls}">${txt}</span></span></li>`;
  }).join("") || "<li><span class='help'>No videos yet.</span></li>";
}

// ---------- settings ----------
async function loadSettings() {
  const r = await api("/api/app-settings");
  settings = r.settings;
  return r;
}
async function showSettings() {
  $("#page-settings").hidden = false;
  const r = await loadSettings();
  const s = r.settings;
  setToggle($("#s-niche"), s.defaultNiche);
  $("#s-pace-guns").value = s.targetShotSec.guns;
  $("#s-pace-tech").value = s.targetShotSec.tech;
  $("#s-captions").checked = s.captions;
  $("#s-web").checked = s.sources.webCrawl;
  $("#s-presskit").checked = s.sources.presskit;
  $("#s-stock").checked = s.sources.stock;
  setToggle($("#s-mode"), s.webCrawlMode);
  $("#keys").innerHTML = Object.entries(r.keys).map(([k, v]) => `<li><span class="dot ${v ? "y" : "n"}"></span>${k}<span class="help">${v ? "set" : "missing"}</span></li>`).join("");
  $("#s-msg").textContent = "";
  showChannelStyle();
  showAi();
}

// ---------- AI model (Claude / Qwen, backup, credit budget) ----------
let ai = null;
const money = (v) => (v === null || v === undefined ? "" : `$${Number(v).toFixed(2)}`);
const numOrNull = (el) => (el.value.trim() === "" ? null : Number(el.value));
async function showAi(state) {
  ai = state || (await api("/api/llm"));
  const s = ai.settings;
  setToggle($("#ai-primary"), s.primary);
  setToggle($("#ai-fallback"), s.fallback);
  setToggle($("#ai-qmode"), s.qwen.mode);
  setToggle($("#ai-qdevice"), s.qwen.device || "auto");
  $("#ai-qdevice-wrap").hidden = s.qwen.mode !== "local";
  $("#ai-qurl").value = s.qwen.baseUrl;
  $("#ai-qmodel").value = s.qwen.model;
  $("#ai-qvision").value = s.qwen.visionModel;
  $("#ai-qpin").value = s.qwen.priceIn;
  $("#ai-qpout").value = s.qwen.priceOut;
  $("#ai-ccredit").value = s.budget.claude.creditUsd ?? "";
  $("#ai-cstop").value = s.budget.claude.stopBelowUsd;
  $("#ai-qcredit").value = s.budget.qwen.creditUsd ?? "";
  $("#ai-qstop").value = s.budget.qwen.stopBelowUsd;
  const row = (p, label) => {
    const st = ai.status[p];
    const using = ai.active === p ? " · <b>in use</b>" : "";
    const spend = `spent ${money(st.spentUsd)}${st.remainingUsd !== null ? ` · ~${money(st.remainingUsd)} left` : ""} · ${st.calls} calls`;
    return `<li><span class="dot ${st.blocked ? "n" : "y"}"></span><b>${label}</b><span class="help">${st.blocked ? esc(st.blocked) : "ready"}${using} · ${spend}</span>
      <span class="ai-actions">${st.disabled ? `<button class="btn small" data-enable="${p}">Re-enable</button>` : ""}<button class="btn small ghost" data-test="${p}">Test</button></span></li>`;
  };
  $("#ai-status").innerHTML = row("claude", "Claude") + row("qwen", `Qwen (${s.qwen.mode === "local" ? "local" : "cloud"})`) +
    (ai.order.length ? "" : `<li><span class="help">No model available: the pipeline will use the free built-in rules.</span></li>`);
}
onToggle($("#ai-primary"), (v) => (ai.settings.primary = v));
onToggle($("#ai-fallback"), (v) => (ai.settings.fallback = v));
onToggle($("#ai-qdevice"), async (v) => {
  showAi(await api("/api/llm", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ qwen: { device: v } }) }));
});
onToggle($("#ai-qmode"), async (v) => {
  // Switching cloud / local loads that mode's preset (endpoint + model names).
  showAi(await api("/api/llm", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ qwen: { mode: v } }) }));
});
$("#ai-status").addEventListener("click", async (e) => {
  const b = e.target.closest("button");
  if (!b) return;
  b.disabled = true;
  try {
    if (b.dataset.enable) {
      showAi(await api("/api/llm/enable", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ provider: b.dataset.enable }) }));
      $("#ai-msg").textContent = "Re-enabled.";
    } else if (b.dataset.test) {
      $("#ai-msg").textContent = "Testing…";
      const r = await api("/api/llm/test", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ provider: b.dataset.test }) });
      showAi(r.state);
      $("#ai-msg").textContent = r.ok ? `${b.dataset.test} OK (${r.model}, ${r.ms} ms): "${r.reply}"` : `${b.dataset.test} failed: ${r.error}`;
    }
  } catch (err) {
    $("#ai-msg").textContent = err.message;
  } finally {
    b.disabled = false;
  }
});
$("#ai-save").addEventListener("click", async () => {
  const body = {
    primary: ai.settings.primary,
    fallback: ai.settings.fallback,
    qwen: { baseUrl: $("#ai-qurl").value, model: $("#ai-qmodel").value, visionModel: $("#ai-qvision").value, priceIn: Number($("#ai-qpin").value || 0), priceOut: Number($("#ai-qpout").value || 0) },
    budget: {
      claude: { creditUsd: numOrNull($("#ai-ccredit")), stopBelowUsd: Number($("#ai-cstop").value || 0) },
      qwen: { creditUsd: numOrNull($("#ai-qcredit")), stopBelowUsd: Number($("#ai-qstop").value || 0) },
    },
  };
  showAi(await api("/api/llm", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }));
  $("#ai-msg").textContent = "Saved. Agla step naye model se chalega.";
});
onToggle($("#s-niche"), (v) => (settings.defaultNiche = v));
onToggle($("#s-mode"), (v) => (settings.webCrawlMode = v));
$("#s-save").addEventListener("click", async () => {
  const body = {
    defaultNiche: settings.defaultNiche,
    targetShotSec: { guns: Number($("#s-pace-guns").value), tech: Number($("#s-pace-tech").value) },
    captions: $("#s-captions").checked,
    sources: { webCrawl: $("#s-web").checked, presskit: $("#s-presskit").checked, stock: $("#s-stock").checked },
    webCrawlMode: settings.webCrawlMode,
  };
  await api("/api/app-settings", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  $("#s-msg").textContent = "Saved. Next video will use these settings.";
  niche = body.defaultNiche;
});

// ---------- channel style preset ----------
let styleMeta = null, chList = [];
async function showChannelStyle() {
  styleMeta ??= await api("/api/style-meta").catch(() => ({ cards: [], fonts: ["Anton"] }));
  chList = await api("/api/channels").catch(() => []);
  const sel = $("#cs-channel");
  const cur = sel.value;
  sel.innerHTML = chList.map((c) => `<option>${esc(c.name)}</option>`).join("");
  if (cur) sel.value = cur;
  $("#cs-font").innerHTML = styleMeta.fonts.map((f) => `<option>${esc(f)}</option>`).join("");
  $("#cs-capstyle").innerHTML = (styleMeta.captionStyles || []).map((c) => `<option value="${esc(c.id)}" title="${esc(c.description)}">${esc(c.label)}</option>`).join("");
  fillChannelStyle();
}
function fillChannelStyle() {
  const c = chList.find((x) => x.name === $("#cs-channel").value);
  if (!c) return;
  const st = c.style || {}, cards = st.cards || {};
  $("#cs-font").value = cards.font || "Anton";
  $("#cs-primary").value = cards.primary || "#ffd60a";
  $("#cs-text").value = cards.text || "#ffffff";
  $("#cs-every").value = cards.graphicsEverySec || 25;
  $("#cs-pace").value = (st.pacing && st.pacing.targetShotSec) || "";
  $("#cs-capstyle").value = (st.captions && st.captions.preset) || "classic";
  const set = new Set(cards.set || styleMeta.cards);
  $("#cs-set").innerHTML = styleMeta.cards.map((k) => `<label><input type="checkbox" value="${k}" ${set.has(k) ? "checked" : ""}>${k}</label>`).join("");
  $("#cs-msg").textContent = "";
}
$("#cs-channel").addEventListener("change", fillChannelStyle);
$("#cs-save").addEventListener("click", async () => {
  const ch = $("#cs-channel").value;
  const body = { cards: { font: $("#cs-font").value, primary: $("#cs-primary").value, text: $("#cs-text").value, graphicsEverySec: Number($("#cs-every").value), set: [...document.querySelectorAll("#cs-set input:checked")].map((i) => i.value) } };
  if ($("#cs-pace").value) body.pacing = { targetShotSec: Number($("#cs-pace").value) };
  body.captions = { preset: $("#cs-capstyle").value };
  try {
    await api(`/api/channels/${encodeURIComponent(ch)}/style`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    $("#cs-msg").textContent = "Saved. Next render of this channel uses it.";
    chList = await api("/api/channels");
  } catch (err) { $("#cs-msg").textContent = err.message; }
});

// ---------- start ----------
loadSettings().then(() => { niche = settings.defaultNiche; }).catch(() => {});
loadChannels().then(() => refreshMusicOptions());
refreshModes();
route();
