// Block-based multi-track editor. Talks JSON-RPC 2.0 to POST /api/editor (src/server/routes/editorAPI.ts).
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const project = new URLSearchParams(location.search).get("project") || "";

const st = { view: null, selected: null, px: 3, playFrame: 0, job: null, rpcId: 0, playing: false, markIn: null, markOut: null, shown: null };
const HELP = $("edInspector").innerHTML;
const TRACK_LABEL = { voiceover: "Voice", broll: "B-roll", overlay: "Overlays", captions: "Captions", music: "Music", sfx: "SFX" };

function toast(msg, err = false) {
  const t = $("toast");
  t.textContent = msg;
  t.className = `toast${err ? " err" : ""}`;
  clearTimeout(t._h);
  t._h = setTimeout(() => t.classList.add("hidden"), 5000);
}

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
  if (!project) {
    $("edEmpty").textContent = 'Open the editor from a project (index.html → project → "Open editor").';
    return;
  }
  $("edProject").textContent = project;
  $("edBack").href = `index.html#${encodeURIComponent(project)}`;
  $("edAudio").src = `/api/projects/${encodeURIComponent(project)}/audio`;
  try {
    setView(await rpc("editor.open"));
  } catch (e) {
    $("edEmpty").textContent = e.message;
  }
}

function setView(v) {
  st.view = v;
  $("edRev").textContent = `revision ${v.revision}${v.dirty.length ? ` · ${v.dirty.length} scene(s) edited, not rendered` : ""}`;
  $("edUndo").disabled = !v.canUndo;
  $("edRedo").disabled = !v.canRedo;
  if (st.selected && !findBlock(st.selected)) st.selected = null;
  st.playFrame = Math.min(st.playFrame, Math.max(0, v.totalFrames - 1));
  st.shown = null;
  draw();
  inspect();
  showFrame();
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
          const cls = ["ed-block", b.kind, b.verified ? "verified" : "", b.locked ? "locked" : "", st.selected === b.id ? "selected" : ""].join(" ");
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

// ---------- live preview (picture under the playhead + the voice) ----------

function showFrame(fromPlayback = false) {
  if (!st.view) return;
  const f = st.playFrame;
  const b = blockAt("broll", f);
  const vid = $("edVideo");
  const img = $("edImg");
  $("edEmpty").hidden = !!b;
  if (!b) {
    vid.hidden = img.hidden = true;
    $("edEmpty").textContent = "No picture here";
  } else {
    const changed = st.shown !== b.id;
    if (changed) {
      // Show the scene's transition when playback runs into it.
      const stage = $("edStage");
      stage.classList.remove("fade", "flash");
      if (fromPlayback && b.transition && b.transition !== "cut" && f - b.startFrame < 4) void stage.offsetWidth, stage.classList.add(b.transition);
    }
    if (b.mediaKind === "image") {
      vid.hidden = true;
      if (!vid.paused) vid.pause();
      img.hidden = false;
      if (changed) img.src = b.media;
    } else {
      img.hidden = true;
      vid.hidden = false;
      const want = (b.sourceIn || 0) + (f - b.startFrame) / st.view.fps;
      if (changed && vid.dataset.src !== b.media) (vid.src = b.media), (vid.dataset.src = b.media);
      if (changed || !fromPlayback || Math.abs(vid.currentTime - want) > 0.35) {
        try {
          vid.currentTime = want;
        } catch {}
      }
      if (st.playing && vid.paused) vid.play().catch(() => {});
      if (!st.playing && !vid.paused) vid.pause();
    }
    st.shown = b.id;
  }
  const card = blockAt("overlay", f);
  $("edCard").hidden = !card;
  if (card) $("edCard").textContent = `▣ ${card.label}`;
  const sc = st.view.scenes.find((s) => f >= s.startFrame && f < s.startFrame + s.frames);
  $("edSceneText").textContent = sc ? `#${sc.id}: ${sc.text}` : "";
  syncVoice(fromPlayback);
}

/** The voice may be in pieces after a cut: play the piece under the playhead from the right spot. */
function syncVoice(fromPlayback) {
  const a = $("edAudio");
  const v = blockAt("voiceover", st.playFrame);
  const want = v ? (v.sourceIn || 0) + (st.playFrame - v.startFrame) / st.view.fps : 0;
  if (!v || !st.playing) {
    if (!a.paused) a.pause();
    if (v && !fromPlayback) a.currentTime = want;
    return;
  }
  if (Math.abs(a.currentTime - want) > 0.2) a.currentTime = want;
  if (a.paused) a.play().catch(() => {});
}

function seek(frame) {
  if (!st.view) return;
  st.playFrame = Math.max(0, Math.min(st.view.totalFrames - 1, Math.round(frame)));
  if (st.playing) (st.clock0 = performance.now()), (st.frame0 = st.playFrame);
  movePlayhead();
  showFrame();
}

function tick() {
  if (!st.playing) return;
  const f = st.frame0 + ((performance.now() - st.clock0) / 1000) * st.view.fps;
  if (f >= st.view.totalFrames - 1) {
    st.playFrame = st.view.totalFrames - 1;
    movePlayhead();
    return setPlaying(false);
  }
  st.playFrame = Math.floor(f);
  movePlayhead();
  showFrame(true);
  // Keep the playhead in view.
  const sc = $("edScroll");
  const px = x(st.playFrame);
  if (px > sc.scrollLeft + sc.clientWidth - 40 || px < sc.scrollLeft) sc.scrollLeft = px - 80;
  requestAnimationFrame(tick);
}

function setPlaying(on) {
  if (!st.view) return;
  st.playing = on;
  $("edPlay").textContent = on ? "❚❚" : "▶";
  if (on) {
    if (st.playFrame >= st.view.totalFrames - 2) st.playFrame = 0;
    st.clock0 = performance.now();
    st.frame0 = st.playFrame;
    requestAnimationFrame(tick);
  }
  showFrame(on);
}

// ---------- inspector ----------

function inspect() {
  const box = $("edInspector");
  const hit = st.selected && findBlock(st.selected);
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
      <div id="insCandList" class="ed-cands"></div>` : ""}`;
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
    $("insCands").onclick = () => showCandidates(block.id);
    $("insFetch").onclick = () => fetchNew(block.id, $("insKeyword").value.trim());
    if (st.job && st.job.clipId === block.id) pollJob();
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
  try {
    const r = await rpc("editor.render");
    toast(r.editedScenes.length ? `Rendering - scenes ${r.editedScenes.join(", ")} re-render, the rest come from cache` : "Rendering (nothing edited: every scene comes from cache)");
    setView(await rpc("editor.open"));
  } catch (e) {
    handleError(e);
  }
};

document.addEventListener("keydown", (e) => {
  // The target is the document (not an element) when nothing has focus.
  if (e.target instanceof Element && e.target.closest("input, textarea, select")) return;
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") (e.preventDefault(), undoRedo(e.shiftKey ? "redo" : "undo"));
  else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "y") (e.preventDefault(), undoRedo("redo"));
  else if (e.ctrlKey || e.metaKey || e.altKey) return;
  else if (e.key === "Delete" || e.key === "Backspace") (e.preventDefault(), deleteSelected());
  else if (e.key.toLowerCase() === "s") split();
  else if (e.key.toLowerCase() === "i") $("edIn").click();
  else if (e.key.toLowerCase() === "o") $("edOut").click();
  else if (e.key.toLowerCase() === "x") cutOut();
  else if (e.key === "Escape") $("edClear").click();
  else if (e.key === "ArrowLeft") (e.preventDefault(), seek(st.playFrame - (e.shiftKey ? 30 : 1)));
  else if (e.key === "ArrowRight") (e.preventDefault(), seek(st.playFrame + (e.shiftKey ? 30 : 1)));
  else if (e.key === " ") (e.preventDefault(), setPlaying(!st.playing));
});

st.px = Number($("edZoom").value) / 2;
load();
