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

function setToggle(el, v) { el.querySelectorAll("button").forEach((b) => b.classList.toggle("on", b.dataset.v === v)); }
function onToggle(el, fn) { el.addEventListener("click", (e) => { const b = e.target.closest("button"); if (b) { setToggle(el, b.dataset.v); fn(b.dataset.v); } }); }
const fmtDur = (ms) => { const s = Math.max(0, Math.round(ms / 1000)); const m = Math.floor(s / 60); return m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : m ? `${m}m ${String(s % 60).padStart(2, "0")}s` : `${s}s`; };

// ---------- router ----------
function route() {
  clearInterval(poll);
  const [, page, arg] = (location.hash || "#/create").split("/");
  document.querySelectorAll(".page").forEach((p) => (p.hidden = true));
  document.querySelectorAll("nav a[data-nav]").forEach((a) => a.classList.toggle("active", a.dataset.nav === (page === "project" ? "videos" : page || "create")));
  if (page === "project" && arg) return showProject(decodeURIComponent(arg));
  if (page === "videos") return showVideos();
  if (page === "settings") return showSettings();
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
  $("#mode-note").textContent = m === "both" ? "Script + voiceover: best timing." : m === "voice" ? "Voiceover only: words are transcribed." : m === "tts" ? "Script only: computer test voice." : "No voiceover? A computer test voice reads the script.";
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

$("#go").addEventListener("click", async () => {
  const err = $("#create-error");
  err.textContent = "";
  const title = $("#title").value.trim();
  const d = new Date();
  const stamp = `${d.getMonth() + 1}${String(d.getDate()).padStart(2, "0")}-${String(d.getHours()).padStart(2, "0")}${String(d.getMinutes()).padStart(2, "0")}`;
  const name = `${slugify(title || ($("#script").value.trim().split(/\s+/).slice(0, 5).join(" ")) || "video") || "video"}-${stamp}`;
  if (!mode()) return (err.textContent = "Script paste karein ya voiceover upload karein (ya dono).");
  const btn = $("#go");
  btn.disabled = true;
  try {
    if (audioFile) {
      btn.textContent = "Uploading voiceover...";
      await api(`/api/projects/${name}/audio`, { method: "POST", headers: { "x-filename": audioFile.name }, body: audioFile });
    }
    btn.textContent = "Starting...";
    await api(`/api/projects/${name}/go`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ script: $("#script").value, title, channel: $("#channel").value, review: $("#review").checked }) });
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

async function showProject(name) {
  $("#page-project").hidden = false;
  $("#p-title").textContent = name;
  $("#result").hidden = true;
  $("#review-box").hidden = true;
  let since = 0;
  let firstSeen = null;
  const logEl = $("#log");
  logEl.textContent = "";
  const proj = await api(`/api/projects/${name}`).catch(() => null);
  const tick = async () => {
    const j = await api(`/api/projects/${name}/log?since=${since}`).catch(() => null);
    if (!j) return;
    since = j.total;
    if (j.lines.length) { logEl.textContent += j.lines.join("\n") + "\n"; logEl.scrollTop = logEl.scrollHeight; }
    const tts = proj?.voiceMode === "tts" || /=== voice ===/.test(logEl.textContent);
    const state = stepStates(j, tts);
    $("#steps").innerHTML = STEPS.map(([k, label], i) => {
      const s = state[k];
      const ic = s === "done" ? "&#10003;" : s === "failed" ? "!" : s === "skip" ? "&ndash;" : String(i + 1);
      return `<li class="${s}"><span class="ic">${ic}</span>${label}<small>${STATE_TXT[s]}</small></li>`;
    }).join("");

    // percent: weights of finished steps + partial of the running one
    const active = STEPS.filter(([k]) => state[k] !== "skip");
    const total = active.reduce((a, [, , w]) => a + w, 0);
    let got = 0;
    for (const [k, , w] of active) { if (state[k] === "done") got += w; else if (state[k] === "running") got += w * Math.min(0.95, stepFraction(logEl.textContent)); }
    let pct = Math.round((got / total) * 100);
    const allDone = !j.running && state.qa === "done";
    if (allDone) pct = 100;
    const fill = $("#p-fill");
    fill.style.width = pct + "%";
    fill.className = "fill" + (allDone ? " done" : !j.running && j.failedStep ? " failed" : "");
    $("#p-pct").textContent = pct + "%";

    const cur = STEPS.find(([k]) => state[k] === "running");
    if (j.running) {
      firstSeen ??= { t: Date.now(), pct };
      const el = Date.now() - firstSeen.t, dp = pct - firstSeen.pct;
      const eta = el > 20000 && dp > 2 ? (el / dp) * (100 - pct) : null;
      $("#p-eta").textContent = `Step ${STEPS.indexOf(cur) + 1} of ${STEPS.length}: ${cur ? cur[1] : "starting"}` + (eta ? ` \u00b7 about ${fmtDur(eta)} left` : " \u00b7 footage step can take 20-30 min");
    } else $("#p-eta").textContent = "";
    $("#p-status").textContent = j.running ? `Video ban rahi hai: ${cur ? cur[1] : "starting"}...`
      : j.failedStep ? `Stopped at ${j.failedStep}. Log neeche dekhein.`
      : allDone ? "Done! Video tayyar hai." : j.awaitingApproval ? "Plan ready, waiting for approval (Classic editor)." : "Not started yet.";
    if (j.awaitingReview) $("#p-status").textContent = "Scenes ready: review karein, phir Render dabayein.";
    if (!j.running) {
      clearInterval(poll);
      if (j.awaitingReview) showReview(name);
      else if (j.steps.render === "done") showResult(name);
    }
  };
  await tick();
  poll = setInterval(tick, 2500);
}

// ---------- scene review ----------
let rvSel = {};
const fmtT = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
function rvRow(name, sc) {
  const sel = rvSel[sc.id] ?? 0;
  const shots = sc.shots.map((x) => `<div class="tile ${x.index === sel ? "sel" : ""} ${x.reused ? "reused" : ""}" data-shot="${x.index}" data-scene="${sc.id}" title="${esc(x.file)}"><img loading="lazy" src="/api/projects/${name}/review/thumb?scene=${sc.id}&shot=${x.index}"><span>${x.seconds}s \u00b7 ${x.verified ? "\u2713 " : x.product ? "stock \u00b7 " : ""}${esc(x.shotType || x.source)}</span></div>`).join("");
  const alts = sc.card ? "<span class='help'>Card scene (graphic)</span>" : sc.alternatives.length ? sc.alternatives.map((a) => `<div class="tile alt" data-alt="${esc(a.id)}" data-scene="${sc.id}" title="${esc(a.author || "")}"><img loading="lazy" src="/api/projects/${name}/review/thumb?alt=${encodeURIComponent(a.id)}"><span>${esc(a.shotType || "")} \u00b7 ${a.match}</span></div>`).join("") : "<span class='help'>No unused alternatives in the pool.</span>";
  return `<div class="rv-row" id="rv-${sc.id}"><div class="rv-meta"><b>#${sc.id}</b>${fmtT(sc.start)}-${fmtT(sc.end)}${sc.product ? `<br>${esc(sc.product)}` : ""}</div>
    <div><div class="rv-text">${esc(sc.text)}</div><div class="rv-shots">${shots}</div><div class="rv-alts">${alts}</div></div></div>`;
}
// Exact-model footage per product chapter; insufficient footage is a clear warning, never hidden.
function footageBanner(list) {
  if (!list || !list.length) return "";
  const rows = list.map((c) => {
    const v = Math.round(c.verifiedShare * 100), st = Math.round(c.stockShare * 100);
    const warn = c.insufficient
      ? `<b style="color:#c0392b">\u26a0 Insufficient footage:</b> sirf ${c.poolVerified} verified clip(s) mile${c.poolTarget ? ` (target ${c.poolTarget})` : ""}. Apni clips ya press-kit media add karein.`
      : `${c.poolVerified} verified clip(s)${c.poolTarget ? ` / target ${c.poolTarget}` : ""}`;
    return `<div style="padding:6px 0;border-bottom:1px solid rgba(127,127,127,.2)"><b>${esc(c.product)}</b>: ${v}% verified exact model, ${st}% stock \u00b7 ${warn}</div>`;
  }).join("");
  const bad = list.some((c) => c.insufficient);
  return `<div class="rv-footage" style="margin:0 0 14px;padding:10px 14px;border-radius:10px;border:1px solid ${bad ? "#c0392b" : "rgba(127,127,127,.35)"}"><div style="font-weight:600;margin-bottom:4px">Product footage check</div>${rows}</div>`;
}
async function showReview(name) {
  const box = $("#review-box");
  box.hidden = false;
  const r = await api(`/api/projects/${name}/review`).catch((e) => ({ scenes: [], error: e.message }));
  $("#rv").innerHTML = footageBanner(r.footage) + (r.scenes.map((sc) => rvRow(name, sc)).join("") || `<p class="help">${esc(r.error || "No scenes.")}</p>`);
  box.dataset.name = name;
  box._scenes = r.scenes;
}
$("#rv").addEventListener("click", async (e) => {
  const box = $("#review-box");
  const name = box.dataset.name;
  const t = e.target.closest(".tile");
  if (!t) return;
  const id = Number(t.dataset.scene);
  const row = () => box._scenes.find((s) => s.id === id);
  if (t.dataset.shot !== undefined) { rvSel[id] = Number(t.dataset.shot); $(`#rv-${id}`).outerHTML = rvRow(name, row()); return; }
  if (t.dataset.alt) {
    t.style.opacity = 0.4;
    try {
      const r = await api(`/api/projects/${name}/review/swap`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ scene: id, shot: rvSel[id] ?? 0, alt: t.dataset.alt }) });
      box._scenes = box._scenes.map((s) => (s.id === id ? r.scene : s));
      $(`#rv-${id}`).outerHTML = rvRow(name, r.scene);
    } catch (err) { t.style.opacity = 1; alert(err.message); }
  }
});
$("#render-btn").addEventListener("click", async () => {
  const name = $("#review-box").dataset.name;
  $("#render-btn").disabled = true;
  try {
    await api(`/api/projects/${name}/review/render`, { method: "POST" });
    showProject(name);
  } catch (err) { alert(err.message); } finally { $("#render-btn").disabled = false; }
});

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
  showPublish(name);
  $("#player").src = `/api/projects/${name}/video?t=${Date.now()}`;
  $("#download").href = `/api/projects/${name}/video?download=1`;
  $("#license").href = `/api/projects/${name}/license`;
  const qa = await api(`/api/projects/${name}/file/qa_report.json`).catch(() => null);
  if (qa) {
    $("#qa-sum").innerHTML = `<span class="pill p">${qa.summary.pass} pass</span><span class="pill w">${qa.summary.warn} warnings</span><span class="pill f">${qa.summary.fail} fail</span>`;
    $("#qa-list").innerHTML = qa.checks.filter((c) => c.status !== "pass").map((c) => `<li><span class="st ${c.status}">${c.status.toUpperCase()}</span><b>${esc(c.group)}: ${esc(c.name)}</b><br><small>${esc(String(c.detail).slice(0, 400))}</small></li>`).join("") || "<li>All checks passed.</li>";
  } else $("#qa-sum").textContent = "QA has not run yet.";
  const [scenes, assets] = await Promise.all([api(`/api/projects/${name}/file/scenes.json`), api(`/api/projects/${name}/file/assets.json`)]).catch(() => [[], {}]);
  $("#scene-note").textContent = "Replace clip: pick another option for a scene; only that scene re-renders (about a minute).";
  $("#scenes").innerHTML = scenes.map((s) => {
    const a = assets[s.id] || {};
    const t = `${Math.floor(s.start / 60)}:${String(Math.floor(s.start % 60)).padStart(2, "0")}`;
    return `<div class="scene" data-id="${s.id}"><img loading="lazy" src="/api/projects/${name}/media/${s.id}?thumb=1" onerror="this.style.visibility='hidden'">
      <div class="b"><div><b>#${s.id}</b> \u00b7 ${t} <span class="src">${esc(a.source || "?")}</span>${s.product_name ? ` <span class="src">${esc(s.product_name)}</span>` : ""}</div>
      <div class="t">${esc(s.text)}</div>
      ${a.source === "graphic" ? "<span class='help'>Card (graphic)</span>" : `<button class="btn small ghost" data-replace="${s.id}">Replace clip</button>`}
      <div class="cands"></div></div></div>`;
  }).join("");
}

$("#scenes").addEventListener("click", async (e) => {
  const name = decodeURIComponent(location.hash.split("/")[2]);
  const rb = e.target.closest("[data-replace]");
  const ub = e.target.closest("[data-use]");
  if (rb) {
    const box = rb.parentElement.querySelector(".cands");
    box.innerHTML = "<span class='help'>Loading options...</span>";
    const list = await api(`/api/projects/${name}/candidates/${rb.dataset.replace}`).catch(() => []);
    box.innerHTML = list.length
      ? list.slice(0, 8).map((c) => `<button class="btn small ghost" data-use="${esc(c.id)}" data-scene="${rb.dataset.replace}">${esc(c.source)} \u00b7 ${esc((c.author || c.tags || c.id).slice(0, 34))}</button>`).join("")
      : "<span class='help'>No other options saved for this scene. Use the Classic editor to search.</span>";
  }
  if (ub) {
    ub.textContent = "Replacing...";
    try {
      await api(`/api/projects/${name}/swap/${ub.dataset.scene}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ candId: ub.dataset.use }) });
      showProject(name);
    } catch (err) { ub.textContent = err.message; }
  }
});

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
}
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
  const set = new Set(cards.set || styleMeta.cards);
  $("#cs-set").innerHTML = styleMeta.cards.map((k) => `<label><input type="checkbox" value="${k}" ${set.has(k) ? "checked" : ""}>${k}</label>`).join("");
  $("#cs-msg").textContent = "";
}
$("#cs-channel").addEventListener("change", fillChannelStyle);
$("#cs-save").addEventListener("click", async () => {
  const ch = $("#cs-channel").value;
  const body = { cards: { font: $("#cs-font").value, primary: $("#cs-primary").value, text: $("#cs-text").value, graphicsEverySec: Number($("#cs-every").value), set: [...document.querySelectorAll("#cs-set input:checked")].map((i) => i.value) } };
  if ($("#cs-pace").value) body.pacing = { targetShotSec: Number($("#cs-pace").value) };
  try {
    await api(`/api/channels/${encodeURIComponent(ch)}/style`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    $("#cs-msg").textContent = "Saved. Next render of this channel uses it.";
    chList = await api("/api/channels");
  } catch (err) { $("#cs-msg").textContent = err.message; }
});

// ---------- start ----------
loadSettings().then(() => { niche = settings.defaultNiche; }).catch(() => {});
loadChannels();
refreshModes();
route();
