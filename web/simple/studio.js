// Studio editor (CapCut-style): live preview, multi-track timeline, split / delete / cut out / transitions.
// Lives inside the simple UI's project page; talks JSON-RPC 2.0 to POST /api/editor
// (src/server/routes/editorAPI.ts). window.Studio.open(project) loads a project's timeline.
(() => {
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
let project = "";

const st = { view: null, selected: null, px: 3, playFrame: 0, job: null, rpcId: 0, playing: false, markIn: null, markOut: null, panel: null, model: null, sideTab: "edit", tr: null, trSel: null };
const HELP = $("edInspector").innerHTML;
const TRACK_LABEL = { voiceover: "Voice", broll: "B-roll", overlay: "Overlays", captions: "Captions", music: "Music", sfx: "SFX" };

function toast(msg, err = false) {
  const t = $("toast");
  t.textContent = msg;
  t.className = `toast${err ? " err" : ""}`;
  clearTimeout(t._h);
  t._h = setTimeout(() => t.classList.add("hidden"), 5000);
}
window.studioToast = toast;

async function rpc(method, params = {}) {
  const res = await fetch("/api/editor", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: ++st.rpcId, method, params: { project, ...params } }) });
  const body = await res.json();
  if (body.error) {
    const e = new Error(body.error.message);
    e.code = body.error.code;
    throw e;
  }
  return body.result;
}

const fmt = (frames) => {
  const fps = st.view?.fps || 30;
  const s = frames / fps;
  return `${Math.floor(s / 60)}:${(s % 60).toFixed(2).padStart(5, "0")}`;
};
const x = (frame) => frame * st.px;

// ---------- load / render ----------

async function load() {
  try {
    setView(await rpc("editor.open"));
    return true;
  } catch (e) {
    $("edEmpty").hidden = false;
    $("edEmpty").textContent = e.message;
    return false;
  }
}

function setView(v) {
  st.view = v;
  const pending = v.dirty.length ? `${v.dirty.length} scene(s) edited` : v.audioDirty ? "Music changed" : "";
  $("edRev").textContent = pending ? `${pending} - press Render video to apply` : "No unrendered edits";
  $("edRev").classList.toggle("dirty", !!pending);
  $("edUndo").disabled = !v.canUndo;
  $("edRedo").disabled = !v.canRedo;
  if (st.selected && !findBlock(st.selected)) st.selected = null;
  st.playFrame = Math.min(st.playFrame, Math.max(0, v.totalFrames - 1));
  draw();
  inspect();
  refreshPreview();
  if (st.sideTab === "transcript") loadTranscript();
}

function findBlock(id) {
  for (const t of st.view.tracks) {
    const b = t.blocks.find((x) => x.id === id);
    if (b) return { track: t, block: b };
  }
  return null;
}

function draw() {
  const v = st.view;
  const width = x(v.totalFrames) + 40;
  $("edCanvas").style.width = `${width}px`;
  // Ruler: a label every ~80 px.
  const stepSec = [1, 2, 5, 10, 15, 30, 60].find((s) => s * v.fps * st.px >= 80) || 120;
  const ticks = [];
  for (let f = 0; f <= v.totalFrames; f += stepSec * v.fps) ticks.push(`<span style="left:${x(f)}px">${fmt(f).replace(/\.\d+$/, "")}</span>`);
  $("edRuler").innerHTML = ticks.join("");
  $("edScenes").innerHTML = v.scenes
    .map((s) => {
      const tr = sceneTransition(s.id);
      const icon = tr === "fade" ? `<span class="tr" title="fade in">◐</span>` : tr === "flash" ? `<span class="tr" title="flash">✦</span>` : "";
      return `<div class="ed-scene${v.dirty.includes(s.id) ? " dirty" : ""}" style="left:${x(s.startFrame)}px;width:${x(s.frames) - 2}px" title="${esc(s.text)}">${icon}#${s.id}${s.subject.spec ? ` · ${esc(s.subject.spec)}` : ""}</div>`;
    })
    .join("");
  const order = ["broll", "overlay", "sfx", "captions", "voiceover", "music"];
  const tracks = [...v.tracks].sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind));
  $("edLabels").innerHTML = tracks.map((t) => `<div>${esc(TRACK_LABEL[t.kind] || t.name)}</div>`).join("");
  $("edTracks").innerHTML = tracks
    .map(
      (t) => `<div class="ed-track" data-track="${esc(t.id)}">${t.blocks
        .map((b) => {
          const cls = ["ed-block", b.kind, t.kind === "music" ? "music" : "", b.verified ? "verified" : "", b.source === "ai_generated" ? "ai" : "", b.locked ? "locked" : "", st.selected === b.id ? "selected" : ""].join(" ");
          const thumb = b.thumb && x(b.frames) > 50 ? `<img loading="lazy" src="${esc(b.thumb)}" alt="">` : "";
          const handle = (t.kind === "broll" || t.kind === "overlay" || t.kind === "sfx") && !b.locked ? `<div class="ed-handle" data-handle="1"></div>` : "";
          return `<div class="${cls}" data-id="${esc(b.id)}" style="left:${x(b.startFrame)}px;width:${Math.max(3, x(b.frames) - 1)}px" title="${esc(b.label)} · ${fmt(b.frames)}">${thumb}<span>${esc(b.label)}</span>${handle}</div>`;
        })
        .join("")}</div>`,
    )
    .join("");
  movePlayhead();
}

function movePlayhead() {
  $("edPlayhead").style.left = `${x(st.playFrame)}px`;
  $("edTime").textContent = `${fmt(st.playFrame)} / ${fmt(st.view?.totalFrames || 0)}`;
  drawRange();
}

function drawRange() {
  const r = $("edRange");
  const a = st.markIn;
  const b = st.markOut;
  $("edCut").disabled = a === null || b === null || Math.abs(b - a) < 1;
  $("edClear").hidden = a === null && b === null;
  if (a === null && b === null) return void (r.hidden = true);
  const from = a ?? 0;
  const to = b ?? st.playFrame;
  r.hidden = false;
  r.classList.toggle("open", b === null);
  r.style.left = `${x(Math.min(from, to))}px`;
  r.style.width = `${Math.max(2, x(Math.abs(to - from)))}px`;
}

// ---------- blocks under the playhead ----------

const trackOf = (kind) => st.view?.tracks.find((t) => t.kind === kind);
const blockAt = (kind, frame) => trackOf(kind)?.blocks.find((b) => frame >= b.startFrame && frame < b.startFrame + b.frames) || null;
function sceneTransition(sceneId) {
  const first = trackOf("broll")?.blocks.filter((b) => b.sceneId === sceneId).sort((a, b) => a.startFrame - b.startFrame)[0];
  return first?.transition || "cut";
}

// ---------- live preview: the Remotion Player (cards/src/preview, built into preview.bundle.js) ----------
// The player draws the whole timeline (pictures, cards, captions, transitions, logo) and plays the voice
// and music; its clock drives the playhead here.

let player = null;

const previewHandlers = {
  onFrame(frame) {
    st.playFrame = frame;
    movePlayhead();
    showSceneText();
    markSpokenWord();
    if (st.playing) keepPlayheadInView();
  },
  onPlay() {
    stopSample();
    st.playing = true;
    $("edPlay").textContent = "❚❚";
  },
  onPause() {
    st.playing = false;
    $("edPlay").textContent = "▶";
  },
};

function keepPlayheadInView() {
  const sc = $("edScroll");
  const px = x(st.playFrame);
  if (px > sc.scrollLeft + sc.clientWidth - 40 || px < sc.scrollLeft) sc.scrollLeft = px - 80;
}

function showSceneText() {
  const f = st.playFrame;
  const sc = st.view?.scenes.find((s) => f >= s.startFrame && f < s.startFrame + s.frames);
  $("edSceneText").textContent = sc ? `#${sc.id}: ${sc.text}` : "";
}

/** Fetches the timeline as a preview model and hands it to the player (after every edit). */
async function refreshPreview() {
  const forProject = project;
  if (!window.ClipForgePreview) {
    $("edEmpty").hidden = false;
    $("edEmpty").textContent = "The preview engine is not built. Run: npm run build:preview";
    return;
  }
  try {
    const model = await rpc("editor.preview");
    if (forProject !== project) return; // the studio moved to another project meanwhile
    st.model = model;
    $("edEmpty").hidden = true;
    player ??= ClipForgePreview.mount($("edPlayer"), previewHandlers);
    player.setModel(model);
    showSceneText();
  } catch (e) {
    toast(`Preview: ${e.message}`, true);
  }
}

function seek(frame) {
  if (!st.view) return;
  st.playFrame = Math.max(0, Math.min(st.view.totalFrames - 1, Math.round(frame)));
  player?.seek(st.playFrame);
  movePlayhead();
  showSceneText();
}

function setPlaying(on) {
  if (!st.view || !player) return;
  if (!on) return player.pause();
  if (st.playFrame >= st.view.totalFrames - 2) seek(0);
  player.play();
}

// ---------- inspector ----------

function inspect() {
  const box = $("edInspector");
  if (st.panel !== "voice") stopSample();
  const hit = st.selected && findBlock(st.selected);
  if (st.panel && PANELS[st.panel]) return void PANELS[st.panel]();
  if (hit?.track.kind === "music") return void renderMusicPanel();
  if (!hit) return void (box.innerHTML = HELP);
  const { track, block } = hit;
  const scene = st.view.scenes.find((s) => s.id === block.sceneId);
  const isPicture = track.kind === "broll";
  const tr = isPicture && block.sceneId !== undefined ? sceneTransition(block.sceneId) : null;
  box.innerHTML = `
    <h3>${esc(TRACK_LABEL[track.kind] || track.name)} · ${esc(block.label)}</h3>
    <dl>
      <dt>Starts</dt><dd>${fmt(block.startFrame)}</dd>
      <dt>Length</dt><dd>${fmt(block.frames)} (${block.frames} frames)</dd>
      ${block.source ? `<dt>Source</dt><dd>${esc(block.source)}${block.verified ? " · exact model" : ""}</dd>` : ""}
      ${block.keyword ? `<dt>Keyword</dt><dd>${esc(block.keyword)}</dd>` : ""}
      ${scene ? `<dt>Subject</dt><dd>${esc(scene.subject.product || "none")}${scene.subject.spec ? ` / ${esc(scene.subject.spec)}` : ""}</dd>` : ""}
    </dl>
    <div class="row">
      <button class="btn small" id="insSplit" ${block.locked ? "disabled" : ""}>Split at playhead (S)</button>
      <button class="btn small" id="insDelete" ${block.locked || track.kind === "voiceover" ? "disabled" : ""}>Delete</button>
      <button class="btn small" id="insLock">${block.locked ? "Unlock" : "Lock"}</button>
    </div>
    ${tr ? `
      <h3>Transition into scene #${block.sceneId}</h3>
      <div class="row ed-trans">${["cut", "fade", "flash"].map((t) => `<button class="btn small${tr === t ? " on" : ""}" data-tr="${t}">${t === "cut" ? "Cut" : t === "fade" ? "Fade" : "Flash"}</button>`).join("")}
        <button class="btn small" id="insTrAll" title="Use this transition at every scene start">Apply to all</button></div>` : ""}
    ${isPicture ? `
      <h3>Replace picture</h3>
      <div class="row"><input type="text" id="insKeyword" placeholder="keyword (default: scene spec)" value="${esc(scene?.subject.spec || "")}"></div>
      <div class="row">
        <button class="btn small" id="insCands">Show vault clips</button>
        <button class="btn small primary" id="insFetch" ${block.locked ? "disabled" : ""}>Fetch new clip</button>
      </div>
      <div id="insJob"></div>
      <div id="insCandList" class="ed-cands"></div>
      <h3 class="flow-h">New angle with Google Flow</h3>
      <p class="help">Makes a prompt and a reference frame of this clip. Generate it in Flow, download the video, then drop it here.</p>
      <div class="row flow-angles" id="flowAngles">${FLOW_ANGLE_LIST.map((a) => `<button class="btn small${(st.flow?.clipId === block.id ? st.flow.angle : "animate") === a.id ? " on" : ""}" data-angle="${a.id}">${a.label}</button>`).join("")}</div>
      <div class="row"><button class="btn small primary" id="flowMake" ${block.locked ? "disabled" : ""}>Make prompt</button></div>
      <div id="flowBox"></div>` : ""}`;
  $("insSplit").onclick = () => split();
  for (const b of box.querySelectorAll("[data-tr]")) b.onclick = () => edit([{ op: "setTransition", clipId: block.id, transition: b.dataset.tr }]);
  if ($("insTrAll"))
    $("insTrAll").onclick = async () => {
      const firsts = new Map();
      for (const b of trackOf("broll").blocks) if (b.sceneId !== undefined && (!firsts.has(b.sceneId) || b.startFrame < firsts.get(b.sceneId).startFrame)) firsts.set(b.sceneId, b);
      const ops = [...firsts.values()].filter((b) => !b.locked && b.startFrame > 0).map((b) => ({ op: "setTransition", clipId: b.id, transition: tr }));
      if (await edit(ops)) toast(`${tr} at ${ops.length} scene starts`);
    };
  $("insDelete").onclick = () => deleteSelected();
  $("insLock").onclick = () => edit([{ op: "setLocked", clipId: block.id, locked: !block.locked }]);
  if (isPicture) {
    for (const b of box.querySelectorAll("[data-angle]")) b.onclick = () => {
      box.querySelectorAll("[data-angle]").forEach((x) => x.classList.toggle("on", x === b));
      st.flowAngle = b.dataset.angle;
    };
    $("flowMake").onclick = () => makeFlowPrompt(block.id);
    if (st.flow?.clipId === block.id) renderFlowBox();
    $("insCands").onclick = () => showCandidates(block.id);
    $("insFetch").onclick = () => fetchNew(block.id, $("insKeyword").value.trim());
    if (st.job && st.job.clipId === block.id) pollJob();
  }
}

// ---------- background music: preview, panel ----------

const FADE_DEFAULT = { in: 2, out: 3 }; // matches src/audio/duck.ts (DEFAULT_FADE)
const musicBlock = () => trackOf("music")?.blocks[0] || null;

/** Slider feedback: the player re-renders with the new level / fades before the change is committed. */
function previewMusic(b) {
  if (!st.model?.music) return;
  Object.assign(st.model.music, { gainDb: b.gainDb, duck: b.duck, fadeInSec: b.fadeInSec ?? FADE_DEFAULT.in, fadeOutSec: b.fadeOutSec ?? FADE_DEFAULT.out });
  player?.setModel({ ...st.model });
}

async function renderMusicPanel() {
  const box = $("edInspector");
  box.innerHTML = `<div class="music-panel"><h3>Background music</h3><p class="help">Loading...</p></div>`;
  let tracks = [];
  try {
    tracks = (await rpc("editor.musicList")).tracks;
  } catch (e) {
    toast(e.message, true);
  }
  // The selection may have moved while the library loaded.
  if (!(st.panel === "music" || findBlock(st.selected)?.track.kind === "music")) return;
  const b = musicBlock();
  const options = tracks.map((t) => `<option value="${esc(t.name)}"${b?.label === t.name ? " selected" : ""}>${esc(t.name)}</option>`).join("");
  const none = `<p class="help">No tracks in this channel's library yet. Upload one in <a href="#/library">Library &rarr; Music</a>.</p>`;
  if (!b) {
    box.innerHTML = `<div class="music-panel"><h3>Background music</h3><p class="help">This video has no music.</p>
      ${tracks.length ? `<select id="muTrack">${options}</select><div class="row"><button class="btn small primary" id="muAdd">Add music</button></div>` : none}</div>`;
    if (tracks.length) $("muAdd").onclick = () => setMusicTrack($("muTrack").value);
    return;
  }
  const slider = (id, label, min, max, step, value, unit) => `<label><span>${label}</span><b id="${id}Txt">${value} ${unit}</b></label><input type="range" id="${id}" min="${min}" max="${max}" step="${step}" value="${value}">`;
  box.innerHTML = `<div class="music-panel"><h3>Background music</h3>
    <dl><dt>Track</dt><dd>${esc(b.label)}</dd></dl>
    ${tracks.length ? `<select id="muTrack">${options}</select>` : none}
    ${slider("muLvl", "Level", -40, 0, 1, Math.round(b.gainDb), "dB")}
    <label><span>Duck under the voice</span><input type="checkbox" id="muDuck"${b.duck ? " checked" : ""}></label>
    ${slider("muIn", "Fade in", 0, 10, 0.5, b.fadeInSec ?? FADE_DEFAULT.in, "s")}
    ${slider("muOut", "Fade out", 0, 10, 0.5, b.fadeOutSec ?? FADE_DEFAULT.out, "s")}
    <div class="row"><button class="btn small" id="muRemove">Remove music</button></div>
    <p class="help">The preview approximates ducking; the render lowers the music exactly while the voice speaks.</p></div>`;
  const live = (id, prop, unit) => {
    $(id).oninput = () => {
      b[prop] = Number($(id).value);
      $(`${id}Txt`).textContent = `${b[prop]} ${unit}`;
      previewMusic(b);
    };
    $(id).onchange = () => commitAudio({ [prop]: b[prop] });
  };
  live("muLvl", "gainDb", "dB");
  live("muIn", "fadeInSec", "s");
  live("muOut", "fadeOutSec", "s");
  $("muDuck").onchange = () => commitAudio({ duck: $("muDuck").checked });
  if (tracks.length) $("muTrack").onchange = () => setMusicTrack($("muTrack").value);
  $("muRemove").onclick = () => setMusicTrack(null);
}

/** Sends a level / ducking / fade change; the local preview values are replaced by the server's view. */
async function commitAudio(patch) {
  const b = musicBlock();
  if (!b) return;
  if (!(await edit([{ op: "setAudio", clipId: b.id, ...patch }]))) setView(await rpc("editor.open"));
}

async function setMusicTrack(track) {
  try {
    const r = await rpc("editor.musicSet", { baseRevision: st.view.revision, track });
    st.panel = "music";
    setView(r.view);
    toast(track ? "Music set - press Render video to apply" : "Music removed - press Render video to apply");
  } catch (e) {
    handleError(e);
  }
}

$("edMusic").onclick = () => {
  st.panel = "music";
  st.selected = musicBlock()?.id ?? null;
  draw();
  inspect();
};

// ---------- captions and voice panels ----------

const PANELS = { music: renderMusicPanel, captions: renderCaptionsPanel, voice: renderVoicePanel };
const openPanel = (name) => () => {
  st.panel = name;
  st.selected = null;
  draw();
  inspect();
};
$("edCaptions").onclick = openPanel("captions");
$("edVoice").onclick = openPanel("voice");

const sliderRow = (id, label, min, max, step, value, unit) => `<label><span>${label}</span><b id="${id}Txt">${value} ${unit}</b></label><input type="range" id="${id}" min="${min}" max="${max}" step="${step}" value="${value}">`;

function renderCaptionsPanel() {
  const { captions: c } = st.view.settings;
  $("edInspector").innerHTML = `<div class="music-panel"><h3>Captions</h3>
    <label><span>Burned-in captions</span><input type="checkbox" id="ccOn"${c.enabled ? " checked" : ""}></label>
    <div class="cc-styles">${c.styles.map((s) => `<button class="cc-style${c.preset === s.id ? " on" : ""}" data-style="${esc(s.id)}"><b>${esc(s.label)}</b><span>${esc(s.description)}</span></button>`).join("")}</div>
    ${sliderRow("ccSize", "Size", 30, 90, 2, c.fontSize, "px")}
    <p class="help">Captions are burned into every scene, so a change re-renders the whole video. The preview shows the style live.</p></div>`;
  $("ccOn").onchange = () => edit([{ op: "setCaptions", enabled: $("ccOn").checked }]);
  for (const b of $("edInspector").querySelectorAll("[data-style]")) b.onclick = () => edit([{ op: "setCaptions", enabled: true, preset: b.dataset.style }]);
  $("ccSize").oninput = () => ($("ccSizeTxt").textContent = `${$("ccSize").value} px`);
  $("ccSize").onchange = () => edit([{ op: "setCaptions", fontSize: Number($("ccSize").value) }]);
}

let sampleAudio = null;
function stopSample() {
  sampleAudio?.pause();
  sampleAudio = null;
}

function renderVoicePanel() {
  const v = st.view.settings.voice;
  const anyOn = v.denoise !== "off" || v.rumble || v.even || v.loudness;
  const check = (id, key, label, hint) => `<label title="${esc(hint)}"><span>${label}</span><input type="checkbox" id="${id}"${v[key] ? " checked" : ""}></label>`;
  $("edInspector").innerHTML = `<div class="music-panel"><h3>Voice cleanup</h3>
    <label><span>Noise reduction</span><select id="vcDenoise">${["off", "light", "strong"].map((d) => `<option value="${d}"${v.denoise === d ? " selected" : ""}>${d[0].toUpperCase() + d.slice(1)}</option>`).join("")}</select></label>
    ${check("vcRumble", "rumble", "Remove rumble and hum", "High-pass filter at 80 Hz")}
    ${check("vcEven", "even", "Even out the volume", "Gentle compression: quiet and loud words end up closer")}
    ${check("vcLoud", "loudness", "Normalize voice loudness", "About -16 LUFS before mixing; the final video is still set to -14 LUFS")}
    <p class="help">Hear 8 seconds at the playhead, before and after:</p>
    <div class="row"><button class="btn small" id="vsOrig">Original</button><button class="btn small primary" id="vsClean"${anyOn ? "" : " disabled"}>Cleaned</button></div>
    <p class="help" id="vsMsg"></p>
    <p class="help">Noise reduction takes a few dB off steady hiss; it cannot rescue a very noisy recording. The cleanup is applied when you render, and changes only the sound (no scene re-renders).</p></div>`;
  const set = (patch) => edit([{ op: "setVoice", ...patch }]);
  $("vcDenoise").onchange = () => set({ denoise: $("vcDenoise").value });
  $("vcRumble").onchange = () => set({ rumble: $("vcRumble").checked });
  $("vcEven").onchange = () => set({ even: $("vcEven").checked });
  $("vcLoud").onchange = () => set({ loudness: $("vcLoud").checked });
  const play = async (cleaned) => {
    const msg = $("vsMsg");
    stopSample();
    player?.pause();
    msg.textContent = "Making the sample...";
    try {
      const r = await rpc("editor.voiceSample", { frame: st.playFrame, cleaned });
      sampleAudio = new Audio(r.url);
      sampleAudio.onended = () => (msg.textContent = "");
      await sampleAudio.play();
      msg.textContent = `Playing ${cleaned ? "cleaned" : "original"} (${Math.round(r.seconds)} s)`;
    } catch (e) {
      msg.textContent = e.message;
    }
  };
  $("vsOrig").onclick = () => play(false);
  $("vsClean").onclick = () => play(true);
}

// ---------- transcript: click, select, delete words, tighten pauses ----------

const TR_DEFAULTS = { minGapSec: 0.5, keepSec: 0.2 };
let trDragging = false;
let trSpoken = -1;

function showSideTab(tab) {
  st.sideTab = tab;
  setToggle($("st-sidetabs"), tab);
  $("edInspector").hidden = tab !== "edit";
  $("edTranscript").hidden = tab !== "transcript";
  if (tab === "transcript") loadTranscript();
}
$("st-sidetabs").addEventListener("click", (e) => {
  const b = e.target.closest("button");
  if (b) showSideTab(b.dataset.v);
});

const trParams = () => ({ minGapSec: Number($("trMin").value) || TR_DEFAULTS.minGapSec, keepSec: Math.max(0, Number($("trKeep").value) || 0) });
const fmtSec = (frames) => `${(frames / (st.view?.fps || 30)).toFixed(1)} s`;

async function loadTranscript() {
  try {
    st.tr = await rpc("editor.transcript", trParams());
  } catch (e) {
    return toast(e.message, true);
  }
  st.trSel = null;
  renderTranscript();
}

function renderTranscript() {
  const { words, pauses, fps } = st.tr;
  const box = $("trWords");
  if (!words.length) {
    box.innerHTML = `<p class="help">This video has no word timing, so there is no transcript to edit.</p>`;
  } else {
    const pauseAfter = new Map(pauses.map((p) => [p.afterWord, p]));
    box.innerHTML = words
      .map((w, i) => {
        const p = pauseAfter.get(i - 1);
        const chip = p ? `<span class="tp" data-pause="${p.afterWord}" title="Remove the extra silence of this pause">${((p.endFrame - p.startFrame) / fps).toFixed(1)}s</span>` : "";
        return `${chip}<span class="tw" data-i="${i}">${esc(w.text)}</span> `;
      })
      .join("");
  }
  $("trPauses").textContent = pauses.length ? `${pauses.length} pause${pauses.length === 1 ? "" : "s"} to tighten, saves ${(st.tr.savedFrames / fps).toFixed(1)} s` : "No pause is long enough to tighten.";
  $("trTighten").disabled = !pauses.length;
  trSpoken = -1;
  paintSelection();
  markSpokenWord();
}

/** Highlights the word being spoken at the playhead (binary search; words are in time order). */
function markSpokenWord() {
  if (st.sideTab !== "transcript" || !st.tr?.words.length) return;
  const words = st.tr.words;
  let lo = 0;
  let hi = words.length - 1;
  let at = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (words[mid].startFrame <= st.playFrame) (at = mid), (lo = mid + 1);
    else hi = mid - 1;
  }
  if (at >= 0 && st.playFrame >= words[at].endFrame) at = -1; // in a pause
  if (at === trSpoken) return;
  const box = $("trWords");
  const byIndex = (i) => box.querySelector(`.tw[data-i="${i}"]`);
  if (trSpoken >= 0) byIndex(trSpoken)?.classList.remove("cur");
  trSpoken = at;
  if (at < 0) return;
  const el = byIndex(at);
  el?.classList.add("cur");
  // While playing, keep the spoken word in view.
  if (st.playing && el && (el.offsetTop < box.scrollTop || el.offsetTop > box.scrollTop + box.clientHeight - 30)) box.scrollTop = el.offsetTop - 40;
}

const selRange = () => (st.trSel ? [Math.min(st.trSel.a, st.trSel.b), Math.max(st.trSel.a, st.trSel.b)] : null);

function paintSelection() {
  const r = selRange();
  for (const el of $("trWords").querySelectorAll(".tw")) {
    const i = Number(el.dataset.i);
    el.classList.toggle("sel", !!r && i >= r[0] && i <= r[1]);
  }
  const words = st.tr?.words || [];
  $("trDelete").disabled = !r;
  $("trSel").textContent = r ? `${r[1] - r[0] + 1} word${r[1] === r[0] ? "" : "s"}, ${fmtSec(words[r[1]].endFrame - words[r[0]].startFrame)}` : "";
}

$("trWords").addEventListener("mousedown", (e) => {
  const w = e.target.closest(".tw");
  const p = e.target.closest(".tp");
  if (p) return void tightenOne(Number(p.dataset.pause));
  if (!w) return;
  e.preventDefault();
  const i = Number(w.dataset.i);
  if (e.shiftKey && st.trSel) st.trSel.b = i;
  else {
    st.trSel = { a: i, b: i };
    seek(st.tr.words[i].startFrame);
  }
  trDragging = true;
  paintSelection();
});
$("trWords").addEventListener("mouseover", (e) => {
  if (!trDragging) return;
  const w = e.target.closest(".tw");
  if (!w) return;
  st.trSel.b = Number(w.dataset.i);
  paintSelection();
});
window.addEventListener("mouseup", () => (trDragging = false));

async function deleteSelectedWords() {
  const r = selRange();
  if (!r || !st.tr) return;
  setPlaying(false);
  try {
    const res = await rpc("editor.deleteWords", { baseRevision: st.tr.revision, from: r[0], to: r[1] });
    st.trSel = null;
    setView(res.view);
    toast(`Removed ${fmtSec(res.removedFrames)} - press Render video to apply`);
  } catch (e) {
    handleError(e);
  }
}
$("trDelete").onclick = deleteSelectedWords;

async function tightenPauses() {
  setPlaying(false);
  try {
    const res = await rpc("editor.tightenPauses", { baseRevision: st.tr.revision, ...trParams() });
    setView(res.view);
    toast(`Tightened ${res.pauses} pause${res.pauses === 1 ? "" : "s"}, saved ${fmtSec(res.removedFrames)} - press Render video to apply`);
  } catch (e) {
    handleError(e);
  }
}
$("trTighten").onclick = tightenPauses;

/** One pause: remove its extra silence (the same cut "Tighten pauses" makes for it). */
async function tightenOne(afterWord) {
  const p = st.tr.pauses.find((x) => x.afterWord === afterWord);
  if (!p) return;
  if (await edit([{ op: "cutRange", fromFrame: p.cutFrom, toFrame: p.cutTo }])) toast(`Pause shortened by ${fmtSec(p.cutTo - p.cutFrom)}`);
}

for (const id of ["trMin", "trKeep"]) $(id).addEventListener("change", () => st.tr && loadTranscript());

// ---------- Google Flow round trip: prompt + reference frame -> Flow (side window) -> video back ----------

const FLOW_URL = "https://labs.google/fx/tools/flow";
const FLOW_ANGLE_LIST = [
  { id: "animate", label: "Same shot" }, { id: "closeup", label: "Close-up" }, { id: "low", label: "Low angle" },
  { id: "orbit", label: "Orbit" }, { id: "top", label: "Top-down" }, { id: "hands", label: "Hands-on" }, { id: "wide", label: "Wide" },
];

async function makeFlowPrompt(clipId) {
  const btn = $("flowMake");
  btn.disabled = true;
  btn.textContent = "Making...";
  try {
    const angle = st.flowAngle || "animate";
    const r = await rpc("editor.flowPrompt", { clipId, angle, atFrame: st.playFrame });
    st.flow = { clipId, angle, prompt: r.prompt, frameUrl: r.frameUrl, frame: r.frame, seconds: r.seconds, url: r.flowUrl || FLOW_URL };
    renderFlowBox();
  } catch (e) {
    toast(e.message, true);
  } finally {
    btn.disabled = false;
    btn.textContent = "Make prompt";
  }
}

function renderFlowBox() {
  const f = st.flow;
  const box = $("flowBox");
  if (!box || !f) return;
  box.innerHTML = `
    <div class="flow-step"><b>1.</b> Reference frame
      <img class="flow-frame" src="${esc(f.frameUrl)}" alt="reference frame">
      <div class="row"><button class="btn small" id="flowCopyImg">Copy image</button><a class="btn small ghost" href="${esc(f.frameUrl)}" download="${esc(f.frame)}">Download</a></div></div>
    <div class="flow-step"><b>2.</b> Prompt <span class="help">(edit if you like; the clip needs ${f.seconds} s)</span>
      <textarea id="flowPromptText" rows="7">${esc(f.prompt)}</textarea>
      <div class="row"><button class="btn small" id="flowCopy">Copy prompt</button><button class="btn small primary" id="flowOpen">Open Flow beside</button></div></div>
    <div class="flow-step"><b>3.</b> In Flow: add the image as a frame/ingredient, paste the prompt, generate, download the video.</div>
    <div class="flow-step"><b>4.</b> Bring it back
      <label class="flow-drop" id="flowDrop"><input type="file" id="flowFile" accept="video/*" hidden>Drop the Flow video here (or click)</label>
      <div class="row"><button class="btn small" id="flowDl">Use latest from Downloads</button></div>
      <div id="flowDlList" class="flow-dl"></div></div>`;
  $("flowPromptText").oninput = (e) => (f.prompt = e.target.value);
  $("flowCopy").onclick = async () => {
    try { await navigator.clipboard.writeText(f.prompt); toast("Prompt copied"); } catch { $("flowPromptText").select(); toast("Press Ctrl+C to copy", true); }
  };
  $("flowCopyImg").onclick = () => copyImage(f.frameUrl);
  $("flowOpen").onclick = () => openFlowWindow(f.url);
  const drop = $("flowDrop");
  drop.ondragover = (e) => { e.preventDefault(); drop.classList.add("over"); };
  drop.ondragleave = () => drop.classList.remove("over");
  drop.ondrop = (e) => { e.preventDefault(); drop.classList.remove("over"); const file = e.dataTransfer.files[0]; if (file) uploadFlowVideo(file); };
  $("flowFile").onchange = (e) => e.target.files[0] && uploadFlowVideo(e.target.files[0]);
  $("flowDl").onclick = listFlowDownloads;
}

/** Flow cannot be embedded (Google blocks iframes), so it opens as a window on the right half of the screen. */
function openFlowWindow(url) {
  const w = Math.round(screen.availWidth / 2);
  const left = (screen.availLeft || 0) + screen.availWidth - w;
  const win = window.open(url, "clipforge_flow", `popup=yes,width=${w},height=${screen.availHeight},left=${left},top=${screen.availTop || 0}`);
  if (!win) toast("The browser blocked the window - allow pop-ups for this page", true);
  else win.focus();
}

async function copyImage(src) {
  try {
    const blob = await (await fetch(src)).blob();
    // The clipboard takes PNG only.
    const img = await createImageBitmap(blob);
    const c = document.createElement("canvas");
    c.width = img.width;
    c.height = img.height;
    c.getContext("2d").drawImage(img, 0, 0);
    const png = await new Promise((r) => c.toBlob(r, "image/png"));
    await navigator.clipboard.write([new ClipboardItem({ "image/png": png })]);
    toast("Image copied - paste it into Flow with Ctrl+V");
  } catch {
    toast("Could not copy the image - use Download instead", true);
  }
}

function uploadFlowVideo(file) {
  const f = st.flow;
  const box = $("flowDlList");
  box.innerHTML = `<p class="help">Uploading ${esc(file.name)}...</p>`;
  const x = new XMLHttpRequest();
  x.open("POST", `/api/editor/flow-upload?project=${encodeURIComponent(project)}`);
  x.setRequestHeader("x-filename", encodeURIComponent(file.name));
  x.upload.onprogress = (e) => e.lengthComputable && (box.innerHTML = `<p class="help">Uploading ${Math.round((100 * e.loaded) / e.total)}%</p>`);
  x.onload = () => {
    let r = {};
    try { r = JSON.parse(x.responseText); } catch {}
    if (x.status >= 300) return (box.innerHTML = `<p class="help">${esc(r.error || "upload failed")}</p>`);
    importFlow(f.clipId, "upload", r.name);
  };
  x.onerror = () => (box.innerHTML = `<p class="help">upload failed</p>`);
  x.send(file);
}

async function listFlowDownloads() {
  const box = $("flowDlList");
  try {
    const r = await rpc("editor.flowDownloads");
    box.innerHTML = r.items.length
      ? r.items.map((d) => `<button class="ed-cand" data-dl="${esc(d.name)}">${esc(d.name)}<br>${d.mb} MB \u00b7 ${d.minutesAgo} min ago</button>`).join("")
      : `<p class="help">No recent videos in ${esc(r.folder)}.</p>`;
    for (const b of box.querySelectorAll("[data-dl]")) b.onclick = () => importFlow(st.flow.clipId, "downloads", b.dataset.dl);
  } catch (e) {
    box.innerHTML = `<p class="help">${esc(e.message)}</p>`;
  }
}

async function importFlow(clipId, from, name) {
  try {
    const r = await rpc("editor.flowImport", { baseRevision: st.view.revision, clipId, from, name, prompt: st.flow?.prompt });
    st.flow = null;
    setView(r.view);
    toast(`Flow video placed in the scene${r.note ? ` - note: ${r.note}` : ""}. Press Render video to apply.`, !!r.note);
  } catch (e) {
    handleError(e);
  }
}

async function showCandidates(clipId) {
  const list = $("insCandList");
  list.innerHTML = `<p class="muted small">Loading…</p>`;
  try {
    const r = await rpc("editor.candidates", { clipId, keyword: $("insKeyword")?.value.trim() || undefined });
    if (!r.product) return (list.innerHTML = `<p class="muted small">This scene has no product subject, so there is no exact-model vault for it.</p>`);
    list.innerHTML =
      r.items.map((c) => `<button class="ed-cand${c.used ? " used" : ""}" data-cand="${esc(c.id)}" title="${esc(c.channel)} · ${esc(c.url)}"><img loading="lazy" src="${esc(c.thumbUrl)}" alt=""><div>${esc(c.keyword || c.feature || c.kind)}${c.used ? " · in use" : ""} · ${c.score.toFixed(2)}</div></button>`).join("") ||
      `<p class="muted small">No clips in the ${esc(r.product)} vault yet - use "Fetch new clip".</p>`;
    for (const b of list.querySelectorAll(".ed-cand")) b.onclick = () => replace(clipId, b.dataset.cand);
  } catch (e) {
    list.innerHTML = `<p class="muted small">${esc(e.message)}</p>`;
  }
}

async function replace(clipId, candidateId) {
  try {
    const r = await rpc("editor.replace", { baseRevision: st.view.revision, clipId, candidateId });
    setView(r.view);
    toast("Picture replaced - press Render changes to re-render that scene");
  } catch (e) {
    handleError(e);
  }
}

async function fetchNew(clipId, keyword) {
  try {
    const r = await rpc("editor.fetchNewClip", { clipId, keyword: keyword || undefined });
    st.job = { id: r.jobId, clipId };
    toast("Searching YouTube for a new exact-model clip…");
    pollJob();
  } catch (e) {
    handleError(e);
  }
}

async function pollJob() {
  if (!st.job) return;
  const box = $("insJob");
  let r;
  try {
    r = await rpc("editor.job", { jobId: st.job.id });
  } catch (e) {
    st.job = null;
    return toast(e.message, true);
  }
  if (box) box.innerHTML = `<div class="ed-job">${esc(r.log.join("\n"))}</div>`;
  if (r.state === "running") return void setTimeout(pollJob, 2000);
  st.job = null;
  if (r.state === "done") {
    toast("New clip swapped in - press Render changes to re-render that scene");
    setView(await rpc("editor.open"));
  } else toast(r.error || "Fetch failed", true);
}

// ---------- edits ----------

function handleError(e) {
  toast(e.message, true);
  if (e.code === -32001) rpc("editor.open").then(setView); // conflict: someone else changed it
  else draw();
}

async function edit(ops) {
  try {
    const r = await rpc("editor.edit", { baseRevision: st.view.revision, ops });
    setView(r.view);
    return true;
  } catch (e) {
    handleError(e);
    return false;
  }
}

/** Splits the selected clip if the playhead is on it, else the picture under the playhead. */
async function split() {
  const f = st.playFrame;
  const sel = st.selected && findBlock(st.selected);
  let target = sel && f > sel.block.startFrame && f < sel.block.startFrame + sel.block.frames ? sel.block : null;
  if (!target) target = blockAt("broll", f);
  if (!target) return toast("Move the playhead onto a clip to split it", true);
  if (f - target.startFrame < 6 || target.startFrame + target.frames - f < 6) return toast("Too close to the clip's edge to split (keep at least 0.2 s on each side)", true);
  st.selected = target.id;
  if (await edit([{ op: "splitClip", clipId: target.id, atFrame: f }])) toast("Split - each piece can now be replaced or deleted");
}

function deleteSelected() {
  if (!st.selected) return toast("Click a clip first, then Delete", true);
  const hit = findBlock(st.selected);
  if (hit?.track.kind === "voiceover") return toast("To remove part of the voice, mark it with In / Out and press Cut out part", true);
  edit([{ op: "deleteClip", clipId: st.selected }]);
}

async function cutOut() {
  if (st.markIn === null || st.markOut === null) return toast("Mark the part first: I at its start, O at its end", true);
  const from = Math.min(st.markIn, st.markOut);
  const to = Math.max(st.markIn, st.markOut);
  setPlaying(false);
  if (!(await edit([{ op: "cutRange", fromFrame: from, toFrame: to }]))) return;
  st.markIn = st.markOut = null;
  seek(from);
  toast(`Cut out ${fmt(to - from)} - press Render changes to build the video`);
}

async function undoRedo(which) {
  try {
    setView(await rpc(which === "undo" ? "editor.undo" : "editor.redo", { baseRevision: st.view.revision }));
  } catch (e) {
    handleError(e);
  }
}

// Drag: a block's right edge = trimEnd (for pictures: the cut between two pictures); an overlay /
// SFX block body = moveClip. Pictures and the voice do not move.
$("edTracks").addEventListener("mousedown", (ev) => {
  const el = ev.target.closest(".ed-block");
  st.panel = null;
  // Clicking the timeline moves the playhead there (CapCut); dragging an edge does not.
  if (!ev.target.closest(".ed-handle")) seek((ev.clientX - $("edCanvas").getBoundingClientRect().left) / st.px);
  if (!el) {
    st.selected = null;
    draw();
    return inspect();
  }
  const hit = findBlock(el.dataset.id);
  st.selected = el.dataset.id;
  draw();
  inspect();
  if (!hit || hit.block.locked) return;
  const handle = !!ev.target.closest(".ed-handle");
  const movable = !handle && (hit.track.kind === "overlay" || hit.track.kind === "sfx");
  if (!handle && !movable) return;
  ev.preventDefault();
  const x0 = ev.clientX;
  const blockEl = $("edTracks").querySelector(`.ed-block[data-id="${CSS.escape(hit.block.id)}"]`);
  const onMove = (e) => {
    const df = Math.round((e.clientX - x0) / st.px);
    if (handle) blockEl.style.width = `${Math.max(3, x(hit.block.frames + df))}px`;
    else blockEl.style.left = `${x(Math.max(0, hit.block.startFrame + df))}px`;
  };
  const onUp = (e) => {
    window.removeEventListener("mousemove", onMove);
    window.removeEventListener("mouseup", onUp);
    const df = Math.round((e.clientX - x0) / st.px);
    if (!df) return draw();
    edit([handle ? { op: "trimEnd", clipId: hit.block.id, endFrame: hit.block.startFrame + hit.block.frames + df } : { op: "moveClip", clipId: hit.block.id, startFrame: hit.block.startFrame + df }]);
  };
  window.addEventListener("mousemove", onMove);
  window.addEventListener("mouseup", onUp);
});

// Ruler / scene strip: click or drag to scrub.
for (const id of ["edRuler", "edScenes"])
  $(id).addEventListener("mousedown", (ev) => {
    if (!st.view) return;
    ev.preventDefault();
    const at = (e) => seek((e.clientX - $("edCanvas").getBoundingClientRect().left) / st.px);
    at(ev);
    const up = () => (window.removeEventListener("mousemove", at), window.removeEventListener("mouseup", up));
    window.addEventListener("mousemove", at);
    window.addEventListener("mouseup", up);
  });

$("edZoom").oninput = () => {
  st.px = Number($("edZoom").value) / 2;
  if (st.view) draw();
};
$("edUndo").onclick = () => undoRedo("undo");
$("edRedo").onclick = () => undoRedo("redo");
$("edPlay").onclick = () => setPlaying(!st.playing);
$("edSplit").onclick = () => split();
$("edDelete").onclick = () => deleteSelected();
$("edIn").onclick = () => {
  st.markIn = st.playFrame;
  if (st.markOut !== null && st.markOut <= st.markIn) st.markOut = null;
  drawRange();
};
$("edOut").onclick = () => {
  if (st.markIn === null) st.markIn = 0;
  if (st.playFrame <= st.markIn) return toast("Out must be after In", true);
  st.markOut = st.playFrame;
  drawRange();
};
$("edCut").onclick = () => cutOut();
$("edClear").onclick = () => {
  st.markIn = st.markOut = null;
  drawRange();
};
$("edRender").onclick = async () => {
  setPlaying(false);
  try {
    const r = await rpc("editor.render");
    toast(r.editedScenes.length ? `Rendering - scenes ${r.editedScenes.join(", ")} re-render, the rest come from cache` : "Rendering the video");
    setView(await rpc("editor.open"));
    window.onStudioRender?.();
  } catch (e) {
    handleError(e);
  }
};

document.addEventListener("keydown", (e) => {
  // Only while the studio is on screen; never while typing.
  if (!project || $("st-editor")?.hidden || document.getElementById("page-project")?.hidden) return;
  if (e.target instanceof Element && e.target.closest("input, textarea, select")) return;
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") (e.preventDefault(), undoRedo(e.shiftKey ? "redo" : "undo"));
  else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "y") (e.preventDefault(), undoRedo("redo"));
  else if (e.ctrlKey || e.metaKey || e.altKey) return;
  else if ((e.key === "Delete" || e.key === "Backspace") && st.sideTab === "transcript" && st.trSel) (e.preventDefault(), deleteSelectedWords());
  else if (e.key === "Delete" || e.key === "Backspace") (e.preventDefault(), deleteSelected());
  else if (e.key.toLowerCase() === "s") split();
  else if (e.key.toLowerCase() === "i") $("edIn").click();
  else if (e.key.toLowerCase() === "o") $("edOut").click();
  else if (e.key.toLowerCase() === "x") cutOut();
  else if (e.key === "Escape") (st.trSel ? ((st.trSel = null), paintSelection()) : $("edClear").click());
  else if (e.key === "ArrowLeft") (e.preventDefault(), seek(st.playFrame - (e.shiftKey ? 30 : 1)));
  else if (e.key === "ArrowRight") (e.preventDefault(), seek(st.playFrame + (e.shiftKey ? 30 : 1)));
  else if (e.key === " ") (e.preventDefault(), setPlaying(!st.playing));
});

st.px = Number($("edZoom").value) / 2;

window.Studio = {
  /** Loads (or reloads) a project's timeline into the studio. Resolves false when there is none yet. */
  async open(name) {
    if (name !== project) {
      player?.pause();
      st.tr = null;
      st.trSel = null;
      showSideTab("edit");
      st.selected = null;
      st.markIn = st.markOut = null;
      st.playFrame = 0;
      st.view = null;
    }
    project = name;
    return load();
  },
  pause() {
    player?.pause();
  },
  close() {
    player?.destroy();
    player = null;
    st.playing = false;
    project = "";
  },
  get project() {
    return project;
  },
};
})();
