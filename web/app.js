// ClipForge local web app. Vanilla JS, talks to the local server in src/server/server.ts.
const $ = (id) => document.getElementById(id);
const api = async (path, opts = {}) => {
  const res = await fetch(`/api${path}`, opts);
  const type = res.headers.get("content-type") || "";
  const body = type.includes("json") ? await res.json() : await res.text();
  if (!res.ok) throw new Error(body.error || body || res.statusText);
  return body;
};
const fmt = (s) => {
  s = Math.max(0, s || 0);
  const m = Math.floor(s / 60);
  return `${m}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
};
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

const STEPS = [
  { key: "transcribe", label: "Transcribe" },
  { key: "align", label: "Align" },
  { key: "plan", label: "Plan scenes" },
  { key: "assets", label: "Assets" },
  { key: "timeline", label: "Timeline" },
  { key: "render", label: "Render" },
  { key: "qa", label: "QA" },
];

const state = {
  current: null,
  file: null,
  status: {},
  scenes: [],
  sections: [],
  assets: null,
  aligned: null,
  duration: 0,
  logTotal: 0,
  poll: null,
  curScene: -1,
};

function toast(msg, err = false) {
  const t = $("toast");
  t.textContent = msg;
  t.className = `toast${err ? " err" : ""}`;
  clearTimeout(t._h);
  t._h = setTimeout(() => t.classList.add("hidden"), 5000);
}

// ---------- boot ----------

async function boot() {
  state.status = await api("/status");
  $("keyChips").innerHTML = [
    ["Claude", state.status.anthropicKey],
    ["Storyblocks", state.status.storyblocksKey],
    ["Pexels", state.status.pexelsKey],
    ["Pixabay", state.status.pixabayKey],
    ["Unsplash", state.status.unsplashKey],
    ["YouTube CC", state.status.youtubeCC?.ok, state.status.youtubeCC?.detail],
  ]
    .map(([n, on, detail]) => `<span class="chip ${on ? "on" : "off"}" title="${esc(detail || (on ? "key set in .env" : "not set in .env"))}">${on ? "●" : "○"} ${n}</span>`)
    .join("");
  if (!state.status.anthropicKey) {
    $("newUseLlm").checked = false;
    $("newUseLlm").disabled = true;
    $("llmHint").textContent = "(add ANTHROPIC_API_KEY to .env)";
  }

  state.niches = await api("/niches");
  const nicheOpts = state.niches.map((n) => `<option value="${esc(n.name)}" title="${esc(n.description)}">${esc(n.label)}</option>`).join("");
  $("newNiche").innerHTML = nicheOpts;
  $("pvNiche").innerHTML = nicheOpts;
  if (state.niches.some((n) => n.name === "guns")) $("newNiche").value = "guns";
  $("batchNiche").innerHTML = nicheOpts;
  $("chNiche").innerHTML = nicheOpts;
  if (state.niches.some((n) => n.name === "guns")) $("batchNiche").value = "guns";
  const pacing = () => {
    const sc = state.niches.find((n) => n.name === $("newNiche").value)?.scenes;
    $("newPacing").textContent = sc ? `(shots ${sc.minLengthSec}-${sc.maxLengthSec}s)` : "(channel pacing)";
  };
  $("newNiche").onchange = pacing;
  pacing();
  state.footageModes = await api("/footage-modes");
  const footOpts = state.footageModes.map((m) => `<option value="${esc(m.name)}">${esc(m.label)}</option>`).join("");
  for (const id of ["newFootage", "batchFootage", "pvFootage"]) $(id).innerHTML = footOpts;
  $("batchLlm").checked = !!state.status.anthropicKey;
  $("batchLlm").disabled = !state.status.anthropicKey;

  state.channels = [];
  $("newChannel").onchange = () => (refreshLibrary(), refreshPresskit());
  $("glossary").value = await api("/glossary");
  refreshPresskit();
  refreshLibrary();
  await refreshChannels();
  initComposer();
  pollQueue();

  await refreshProjects();
  const fromHash = decodeURIComponent(location.hash.slice(1));
  if (fromHash) openProject(fromHash);
}

async function refreshProjects() {
  const list = await api("/projects");
  $("projectList").innerHTML =
    list
      .map(
        (p) => `<li data-name="${esc(p.name)}" class="${p.name === state.current ? "active" : ""}">
          <div class="pname">${esc(p.name)}</div>
          <div class="muted small">${esc(p.audio || "")}${p.hasScript ? " · script" : " · voice-only"}</div>
          <div class="dots">${["transcribe", "align", "plan", "assets", "timeline", "render", "qa"].map((s) => `<span class="dot ${p.steps[s]}"></span>`).join("")}</div>
        </li>`,
      )
      .join("") || `<li class="muted">No projects yet</li>`;
  for (const li of $("projectList").querySelectorAll("li[data-name]")) li.onclick = () => openProject(li.dataset.name);
}

// ---------- new project ----------

const drop = $("drop");
drop.onclick = () => $("audioFile").click();
drop.ondragover = (e) => (e.preventDefault(), drop.classList.add("over"));
drop.ondragleave = () => drop.classList.remove("over");
drop.ondrop = (e) => {
  e.preventDefault();
  drop.classList.remove("over");
  if (e.dataTransfer.files[0]) pickFile(e.dataTransfer.files[0]);
};
$("audioFile").onchange = (e) => e.target.files[0] && pickFile(e.target.files[0]);

function pickFile(f) {
  state.file = f;
  drop.classList.add("has");
  $("dropText").innerHTML = `${esc(f.name)}<br><small>${(f.size / 1024 / 1024).toFixed(1)} MB</small>`;
  if (!$("newName").value) {
    $("newName").value = f.name.replace(/\.[^.]+$/, "").replace(/[^A-Za-z0-9_-]+/g, "-").slice(0, 60);
  }
}

function uploadWithProgress(url, file) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", url);
    xhr.setRequestHeader("x-filename", file.name);
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) $("uploadProgress").firstElementChild.style.width = `${(100 * e.loaded) / e.total}%`;
    };
    xhr.onload = () => (xhr.status < 300 ? resolve() : reject(new Error(JSON.parse(xhr.responseText).error)));
    xhr.onerror = () => reject(new Error("upload failed"));
    xhr.send(file);
  });
}

$("createBtn").onclick = async () => {
  const name = $("newName").value.trim();
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(name)) return toast("Project name: letters, digits, - and _ only", true);
  if (!state.file) return toast("Choose a voiceover file first", true);
  const btn = $("createBtn");
  btn.disabled = true;
  $("uploadProgress").classList.remove("hidden");
  try {
    await uploadWithProgress(`/api/projects/${encodeURIComponent(name)}/audio`, state.file);
    await api(`/projects/${encodeURIComponent(name)}/script`, { method: "PUT", body: $("newScript").value });
    await api(`/projects/${encodeURIComponent(name)}/settings`, {
      method: "PUT",
      body: JSON.stringify({ channel: $("newChannel").value, niche: $("newNiche").value, footage: $("newFootage").value, planGate: $("newPlanGate").checked }),
    });
    await api(`/projects/${encodeURIComponent(name)}/run`, {
      method: "POST",
      body: JSON.stringify({ from: "transcribe", useLlm: $("newUseLlm").checked }),
    });
    toast($("newPlanGate").checked ? "Uploaded. Planning scenes - you will see the plan before footage is fetched." : "Uploaded. Pipeline started.");
    state.file = null;
    drop.classList.remove("has");
    $("dropText").innerHTML = "Drop voiceover here<br><small>mp3 / wav / m4a</small>";
    $("newName").value = "";
    $("newScript").value = "";
    await refreshProjects();
    openProject(name);
  } catch (e) {
    toast(e.message, true);
  } finally {
    btn.disabled = false;
    $("uploadProgress").classList.add("hidden");
    $("uploadProgress").firstElementChild.style.width = "0";
  }
};

// ---------- channels ----------

async function refreshChannels(select) {
  const chans = await api("/channels");
  state.channels = chans;
  const opts = chans.map((c) => `<option>${esc(c.name)}</option>`).join("");
  for (const id of ["newChannel", "batchChannel", "chSel"]) {
    const keep = select && id === "chSel" ? select : $(id).value;
    $(id).innerHTML = opts;
    if (keep && chans.some((c) => c.name === keep)) $(id).value = keep;
  }
  showChannel();
}

function showChannel() {
  const c = state.channels.find((x) => x.name === $("chSel").value);
  if (!c) return;
  const st = c.style;
  const col = st.colors || {};
  $("chNiche").value = st.niche || "general";
  $("chPrimary").value = col.primary || "#e8a317";
  $("chSecondary").value = col.secondary || "#1c1c1c";
  $("chText").value = col.text || "#ffffff";
  $("chCaptions").checked = st.captions?.enabled !== false;
  $("chCapSize").value = st.captions?.fontSize ?? 54;
  $("chMusic").value = st.music?.volumeDb ?? -18;
  $("chDuck").value = st.music?.duckDb ?? -10;
  $("chMg").checked = st.motionGraphics?.enabled !== false;
  $("chSfx").checked = st.motionGraphics?.sfx !== false;
  $("chLogoPos").value = st.logo?.position || "top-right";
  $("chLogoOp").value = st.logo?.opacity ?? 0.8;
  for (const [r, v] of [["chCapSize", "chCapSizeV"], ["chMusic", "chMusicV"], ["chDuck", "chDuckV"], ["chLogoOp", "chLogoOpV"]]) $(v).textContent = $(r).value;
  const img = $("chLogoImg");
  if (st.logo?.path) {
    img.src = `/api/channels/${encodeURIComponent(c.name)}/logo?t=${Date.now()}`;
    img.classList.remove("hidden");
  } else img.classList.add("hidden");
  refreshMusic();
}
$("chSel").onchange = showChannel;
for (const [r, v] of [["chCapSize", "chCapSizeV"], ["chMusic", "chMusicV"], ["chDuck", "chDuckV"], ["chLogoOp", "chLogoOpV"]]) $(r).oninput = () => ($(v).textContent = $(r).value);

$("chSave").onclick = async () => {
  const ch = encodeURIComponent($("chSel").value);
  await api(`/channels/${ch}/style`, {
    method: "PUT",
    body: JSON.stringify({
      niche: $("chNiche").value,
      colors: { primary: $("chPrimary").value, secondary: $("chSecondary").value, text: $("chText").value },
      captions: { enabled: $("chCaptions").checked, fontSize: Number($("chCapSize").value) },
      music: { volumeDb: Number($("chMusic").value), duckDb: Number($("chDuck").value) },
      motionGraphics: { enabled: $("chMg").checked, sfx: $("chSfx").checked },
      logo: { position: $("chLogoPos").value, opacity: Number($("chLogoOp").value) },
    }),
  });
  toast("Channel saved. New renders use it (re-run Timeline + Render for old videos).");
  refreshChannels();
};

function rawUpload(url, file, headers = {}) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", url);
    xhr.setRequestHeader("x-filename", encodeURIComponent(file.name));
    for (const [k, v] of Object.entries(headers)) xhr.setRequestHeader(k, encodeURIComponent(v));
    xhr.onload = () => (xhr.status < 300 ? resolve(JSON.parse(xhr.responseText)) : reject(new Error(JSON.parse(xhr.responseText).error)));
    xhr.onerror = () => reject(new Error("upload failed"));
    xhr.send(file);
  });
}

$("chLogoFile").onchange = async (e) => {
  const f = e.target.files[0];
  if (!f) return;
  try {
    await rawUpload(`/api/channels/${encodeURIComponent($("chSel").value)}/logo`, f);
    toast("Logo saved");
    refreshChannels();
  } catch (err) {
    toast(err.message, true);
  }
  e.target.value = "";
};
$("chLogoDel").onclick = async () => {
  await api(`/channels/${encodeURIComponent($("chSel").value)}/logo`, { method: "DELETE" });
  refreshChannels();
};

async function refreshMusic() {
  const ch = encodeURIComponent($("chSel").value);
  const list = await api(`/channels/${ch}/music`).catch(() => []);
  $("chMusicList").innerHTML =
    list.map((m) => `<li>${esc(m.name)} <span class="muted" title="${esc(m.license)}">${(m.bytes / 1024 / 1024).toFixed(1)} MB</span> <a href="#" class="mu-del" data-file="${esc(m.name)}">remove</a></li>`).join("") ||
    '<li class="muted">No music - videos render with voice only</li>';
  for (const a of $("chMusicList").querySelectorAll(".mu-del")) {
    a.onclick = async (e) => {
      e.preventDefault();
      await api(`/channels/${ch}/music?file=${encodeURIComponent(a.dataset.file)}`, { method: "DELETE" });
      refreshMusic();
    };
  }
}
$("chMusicAdd").onclick = async () => {
  const files = [...$("chMusicFile").files];
  const note = $("chMusicNote").value.trim();
  if (!files.length) return toast("Choose music files", true);
  if (!note) return toast("Write the music licence (where it comes from)", true);
  try {
    for (const f of files) await rawUpload(`/api/channels/${encodeURIComponent($("chSel").value)}/music`, f, { "x-note": note });
    toast(`${files.length} track(s) added`);
    $("chMusicFile").value = "";
    refreshMusic();
  } catch (err) {
    toast(err.message, true);
  }
};
$("chCreate").onclick = async () => {
  try {
    const r = await api("/channels", { method: "POST", body: JSON.stringify({ name: $("chNewName").value, copyFrom: $("chSel").value }) });
    toast(`Channel "${r.name}" created`);
    $("chNewName").value = "";
    refreshChannels(r.name);
  } catch (err) {
    toast(err.message, true);
  }
};

// ---------- batch queue ----------

let batchFiles = [];
const batchDrop = $("batchDrop");
batchDrop.onclick = () => $("batchFiles").click();
batchDrop.ondragover = (e) => (e.preventDefault(), batchDrop.classList.add("over"));
batchDrop.ondragleave = () => batchDrop.classList.remove("over");
batchDrop.ondrop = (e) => {
  e.preventDefault();
  batchDrop.classList.remove("over");
  pickBatch([...e.dataTransfer.files]);
};
$("batchFiles").onchange = (e) => pickBatch([...e.target.files]);
const stem = (n) => n.replace(/\.[^.]+$/, "");
function pickBatch(files) {
  batchFiles = files;
  const audio = files.filter((f) => /\.(mp3|wav|m4a)$/i.test(f.name));
  const scripts = files.filter((f) => /\.txt$/i.test(f.name));
  const paired = audio.filter((a) => scripts.some((s) => stem(s.name) === stem(a.name))).length;
  $("batchDropText").innerHTML = audio.length ? `${audio.length} voiceover(s), ${paired} with a script` : "Drop several voiceovers here";
  batchDrop.classList.toggle("has", audio.length > 0);
}

$("batchAdd").onclick = async () => {
  const audio = batchFiles.filter((f) => /\.(mp3|wav|m4a)$/i.test(f.name));
  if (!audio.length) return toast("Drop voiceovers first", true);
  const btn = $("batchAdd");
  btn.disabled = true;
  $("batchProgress").classList.remove("hidden");
  const names = [];
  try {
    for (const [i, a] of audio.entries()) {
      let name = stem(a.name).replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-|-$/g, "").slice(0, 60) || "video";
      const taken = new Set((await api("/projects")).map((p) => p.name));
      for (let k = 2; taken.has(name); k++) name = `${name.replace(/-\d+$/, "")}-${k}`;
      await uploadWithProgress(`/api/projects/${encodeURIComponent(name)}/audio`, a);
      const script = batchFiles.find((f) => /\.txt$/i.test(f.name) && stem(f.name) === stem(a.name));
      await api(`/projects/${encodeURIComponent(name)}/script`, { method: "PUT", body: script ? await script.text() : "" });
      await api(`/projects/${encodeURIComponent(name)}/settings`, { method: "PUT", body: JSON.stringify({ channel: $("batchChannel").value, niche: $("batchNiche").value, footage: $("batchFootage").value }) });
      names.push(name);
      $("batchProgress").firstElementChild.style.width = `${(100 * (i + 1)) / audio.length}%`;
    }
    await api("/queue", { method: "POST", body: JSON.stringify({ projects: names, useLlm: $("batchLlm").checked }) });
    toast(`${names.length} video(s) queued`);
    pickBatch([]);
    refreshProjects();
    pollQueue();
  } catch (e) {
    toast(e.message, true);
  } finally {
    btn.disabled = false;
    $("batchProgress").classList.add("hidden");
    $("batchProgress").firstElementChild.style.width = "0";
  }
};

let queueTimer = null;
async function pollQueue() {
  clearTimeout(queueTimer);
  const q = await api("/queue").catch(() => null);
  if (!q) return;
  const label = { queued: "waiting", running: "● working", done: "✓ done", failed: "✕ failed" };
  $("queueList").innerHTML =
    q.items
      .map((it) => `<li class="qi-${it.status}"><a href="#${encodeURIComponent(it.project)}">${esc(it.project)}</a> <span>${label[it.status]}</span>
        ${it.qa ? `<span class="small ${it.qa.fail ? "bad" : "ok"}">${it.qa.fail ? `${it.qa.fail} QA issue${it.qa.fail > 1 ? "s" : ""}` : "QA ok"}${it.qa.warn ? ` · ${it.qa.warn} warn` : ""}</span>` : ""}
        ${it.error ? `<span class="muted small">${esc(it.error)}</span>` : ""}
        ${it.status === "queued" ? `<a href="#" class="q-del" data-id="${it.id}">remove</a>` : ""}
        ${it.status === "failed" || it.status === "done" ? `<a href="#" class="q-retry" data-id="${it.id}">${it.status === "failed" ? "retry" : "run again"}</a>` : ""}</li>`)
      .join("") || '<li class="muted">Queue is empty</li>';
  const waiting = q.items.filter((x) => x.status === "queued").length;
  $("queueState").textContent = q.paused ? "paused" : q.working ? `working · ${waiting} waiting` : waiting ? `${waiting} waiting` : "idle";
  $("queuePause").textContent = q.paused ? "Resume" : "Pause";
  $("queuePause").onclick = async () => (await api(`/queue/${q.paused ? "resume" : "pause"}`, { method: "POST" }), pollQueue());
  for (const a of $("queueList").querySelectorAll(".q-del")) a.onclick = async (e) => (e.preventDefault(), await api(`/queue/${a.dataset.id}`, { method: "DELETE" }), pollQueue());
  for (const a of $("queueList").querySelectorAll(".q-retry")) a.onclick = async (e) => (e.preventDefault(), await api("/queue/retry", { method: "POST", body: JSON.stringify({ id: a.dataset.id }) }), pollQueue());
  if (q.working || waiting) {
    refreshProjects();
    queueTimer = setTimeout(pollQueue, 4000);
  }
}
$("queueClear").onclick = async () => (await api("/queue/clear", { method: "POST" }), pollQueue());

// ---------- my clips (own / permitted media) ----------

let libFiles = [];
$("libKind").onchange = () => {
  const product = $("libKind").value === "product";
  $("libLabelTitle").textContent = product ? "Product (exact name, as in glossary)" : "Keywords (what the clip shows)";
  $("libLabel").placeholder = product ? "Sig Sauer P365" : "pistol range shooting";
  product ? $("libLabel").setAttribute("list", "pkProducts") : $("libLabel").removeAttribute("list");
};
const libDrop = $("libDrop");
libDrop.onclick = () => $("libFiles").click();
libDrop.ondragover = (e) => (e.preventDefault(), libDrop.classList.add("over"));
libDrop.ondragleave = () => libDrop.classList.remove("over");
libDrop.ondrop = (e) => {
  e.preventDefault();
  libDrop.classList.remove("over");
  pickLibFiles([...e.dataTransfer.files]);
};
$("libFiles").onchange = (e) => pickLibFiles([...e.target.files]);
function pickLibFiles(files) {
  libFiles = files;
  const mb = files.reduce((s, f) => s + f.size, 0) / 1024 / 1024;
  $("libDropText").textContent = files.length ? `${files.length} file(s), ${mb.toFixed(1)} MB` : "Drop clips / photos here";
  libDrop.classList.toggle("has", files.length > 0);
}

function uploadLib(file, label, note, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", `/api/library?channel=${encodeURIComponent(pkChannel())}`);
    xhr.setRequestHeader("x-filename", encodeURIComponent(file.name));
    xhr.setRequestHeader("x-label", encodeURIComponent(label));
    xhr.setRequestHeader("x-note", encodeURIComponent(note));
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress(e.loaded / e.total);
    xhr.onload = () => (xhr.status < 300 ? resolve() : reject(new Error(JSON.parse(xhr.responseText).error)));
    xhr.onerror = () => reject(new Error("upload failed"));
    xhr.send(file);
  });
}

$("libUpload").onclick = async () => {
  const label = $("libLabel").value.trim();
  const note = $("libNote").value.trim();
  if (!libFiles.length) return toast("Choose files first", true);
  if (!label) return toast($("libKind").value === "product" ? "Write the product name" : "Write a few keywords", true);
  if (!note) return toast("Write where the files come from (source / permission)", true);
  const btn = $("libUpload");
  btn.disabled = true;
  $("libProgress").classList.remove("hidden");
  try {
    for (const [i, f] of libFiles.entries()) {
      await uploadLib(f, label, note, (p) => ($("libProgress").firstElementChild.style.width = `${(100 * (i + p)) / libFiles.length}%`));
    }
    toast(`${libFiles.length} file(s) added. Re-run step 4 (Assets) to use them.`);
    pickLibFiles([]);
    refreshLibrary();
  } catch (e) {
    toast(e.message, true);
  } finally {
    btn.disabled = false;
    $("libProgress").classList.add("hidden");
    $("libProgress").firstElementChild.style.width = "0";
  }
};

async function refreshLibrary() {
  const items = await api(`/library?channel=${encodeURIComponent(pkChannel())}`).catch(() => []);
  $("libList").innerHTML =
    items
      .map((p) => `<li><b>${esc(p.label)}</b> <span class="muted">(${p.files.length})</span>
        <ul>${p.files.map((f) => `<li><span title="${esc(f.note)}">${esc(f.name)}</span> <span class="muted">${(f.bytes / 1024 / 1024).toFixed(1)} MB</span> <a href="#" data-folder="${esc(p.folder)}" data-file="${esc(f.name)}" class="lib-del">remove</a></li>`).join("")}</ul></li>`)
      .join("") || `<li class="muted">No clips yet</li>`;
  for (const a of $("libList").querySelectorAll(".lib-del")) {
    a.onclick = async (e) => {
      e.preventDefault();
      await api(`/library?channel=${encodeURIComponent(pkChannel())}&folder=${encodeURIComponent(a.dataset.folder)}&file=${encodeURIComponent(a.dataset.file)}`, { method: "DELETE" });
      refreshLibrary();
    };
  }
}

// ---------- press kit ----------

const pkChannel = () => $("newChannel").value || "default";

async function refreshPresskit() {
  const glossary = $("glossary").value.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
  $("pkProducts").innerHTML = glossary.map((g) => `<option value="${esc(g)}">`).join("");
  const items = await api(`/presskit?channel=${encodeURIComponent(pkChannel())}`).catch(() => []);
  $("pkList").innerHTML =
    items
      .map((p) => `<li><b>${esc(p.product)}</b> <span class="muted">(${p.files.length} file${p.files.length === 1 ? "" : "s"})</span>
        <ul>${p.files.map((f) => `<li><span title="${esc(f.url)}">${esc(f.name)}</span> <span class="muted">${(f.bytes / 1024 / 1024).toFixed(1)} MB</span> <a href="#" data-folder="${esc(p.folder)}" data-file="${esc(f.name)}" class="pk-del">remove</a></li>`).join("")}</ul></li>`)
      .join("") || `<li class="muted">No press-kit media yet</li>`;
  for (const a of $("pkList").querySelectorAll(".pk-del")) {
    a.onclick = async (e) => {
      e.preventDefault();
      await api(`/presskit?channel=${encodeURIComponent(pkChannel())}&folder=${encodeURIComponent(a.dataset.folder)}&file=${encodeURIComponent(a.dataset.file)}`, { method: "DELETE" });
      refreshPresskit();
    };
  }
}

$("pkAdd").onclick = async () => {
  const btn = $("pkAdd");
  btn.disabled = true;
  btn.textContent = "Downloading…";
  try {
    const r = await api(`/presskit?channel=${encodeURIComponent(pkChannel())}`, {
      method: "POST",
      body: JSON.stringify({ product: $("pkProduct").value, url: $("pkUrl").value, license: $("pkLicense").value }),
    });
    toast(`Added (${(r.bytes / 1024 / 1024).toFixed(1)} MB). Re-run step 4 (Assets) to use it.`);
    $("pkUrl").value = "";
    refreshPresskit();
  } catch (e) {
    toast(e.message, true);
  } finally {
    btn.disabled = false;
    btn.textContent = "Add to press kit";
  }
};

$("pkOfficial").onclick = async () => {
  const btn = $("pkOfficial");
  const one = $("pkProduct").value.trim();
  const products = one
    ? one.split(",").map((s) => s.trim()).filter(Boolean)
    : $("glossary").value.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
  if (!products.length) return toast("Type a product name (or fill the glossary) first", true);
  btn.disabled = true;
  btn.textContent = `Searching ${products.length} product site(s)…`;
  try {
    const r = await api(`/presskit/official?channel=${encodeURIComponent(pkChannel())}`, {
      method: "POST",
      body: JSON.stringify({ products, force: !!one }),
    });
    const got = r.results.filter((x) => x.status === "imported").length;
    $("pkOfficialLog").textContent = r.log.join("\n");
    $("pkOfficialLog").classList.remove("hidden");
    toast(`${got}/${r.results.length} product(s) got official photos. Re-run step 4 (Assets) to use them.`);
    refreshPresskit();
  } catch (e) {
    toast(e.message, true);
  } finally {
    btn.disabled = false;
    btn.textContent = "Find official photos";
  }
};

$("saveGlossary").onclick = async () => {
  await api("/glossary", { method: "PUT", body: $("glossary").value });
  toast("Glossary saved. Re-run Align to apply it.");
};

// ---------- project view ----------

async function openProject(name) {
  let p;
  try {
    p = await api(`/projects/${encodeURIComponent(name)}`);
  } catch (e) {
    return toast(e.message, true);
  }
  state.current = name;
  state.logTotal = 0;
  state.curScene = -1;
  location.hash = encodeURIComponent(name);
  $("log").textContent = "";
  $("empty").classList.add("hidden");
  $("projectView").classList.remove("hidden");
  $("pvName").textContent = name;
  const nicheName = p.niche || "general";
  $("pvNiche").value = nicheName;
  $("pvFootage").value = p.footage || "stock_cc";
  state.planGate = p.planGate;
  const nicheLabel = state.niches?.find((n) => n.name === nicheName)?.label ?? nicheName;
  const footLabel = state.footageModes?.find((m) => m.name === (p.footage || "stock_cc"))?.label ?? "";
  $("pvMeta").textContent = `${p.audio || "no audio"} · ${p.hasScript ? "script mode" : "voice-only mode"} · ${nicheLabel} · ${footLabel} · channel: ${p.channel}`;
  $("audio").src = `/api/projects/${encodeURIComponent(name)}/audio`;
  renderStepper(p.steps);
  refreshProjects();
  await loadResults(p.steps);
  startPolling();
}

function renderStepper(steps) {
  $("stepper").innerHTML = STEPS.map((s, i) => {
    let st = s.soon ? "soon" : steps[s.key] || "pending";
    if (s.key === "assets" && st === "pending" && state.planGate === "waiting") st = "waiting";
    const label = { done: "✓ done", running: "● running…", failed: "✕ failed", pending: "pending", soon: "coming next", waiting: "⏸ approve plan" }[st];
    return `<li class="${st}"><div class="num">${i + 1}</div><div>${s.label}</div><div class="st">${label}</div></li>`;
  }).join("");
}

async function run(body) {
  try {
    await api(`/projects/${encodeURIComponent(state.current)}/run`, { method: "POST", body: JSON.stringify(body) });
    $("logBox").open = true;
    startPolling();
  } catch (e) {
    toast(e.message, true);
  }
}
$("pvNiche").onchange = async (e) => {
  await api(`/projects/${encodeURIComponent(state.current)}/settings`, { method: "PUT", body: JSON.stringify({ niche: e.target.value }) });
  toast("Video type changed. Re-running scenes + assets with the new rules…");
  run({ from: "plan", force: true, useLlm: state.status.anthropicKey });
};
$("pvFootage").onchange = async (e) => {
  await api(`/projects/${encodeURIComponent(state.current)}/settings`, { method: "PUT", body: JSON.stringify({ footage: e.target.value }) });
  if (state.planGate === "waiting") {
    toast("Footage sources changed.");
    return renderPlanBox();
  }
  if (!state.scenes.length) return toast("Footage sources saved.");
  toast("Footage sources changed. Fetching footage again…");
  run({ from: "assets", force: true, useLlm: state.status.anthropicKey });
};
$("approvePlan").onclick = async () => {
  $("approvePlan").disabled = true;
  try {
    await api(`/projects/${encodeURIComponent(state.current)}/plan/approve`, { method: "POST", body: JSON.stringify({ useLlm: state.status.anthropicKey }) });
    state.planGate = "approved";
    $("planBox").classList.add("hidden");
    toast("Plan approved. Fetching footage and rendering…");
    $("logBox").open = true;
    startPolling();
  } catch (e) {
    toast(e.message, true);
  } finally {
    $("approvePlan").disabled = false;
  }
};

async function renderPlanBox() {
  const box = $("planBox");
  if (state.planGate !== "waiting" || state.running) return box.classList.add("hidden");
  const e = await api(`/projects/${encodeURIComponent(state.current)}/plan/estimate`).catch(() => null);
  if (!e) return box.classList.add("hidden");
  const cell = (k, v) => `<div class="cell"><div class="k">${k}</div><div class="v">${v}</div></div>`;
  const types = Object.entries(e.types).map(([t, n]) => `${n} ${t}`).join(" · ");
  const cost = e.planCostUsd ? `$${e.planCostUsd.toFixed(3)} <small>(scene labels)</small>` : `$0 <small>(${esc(e.labeledBy)})</small>`;
  $("planEstimate").innerHTML = [
    cell("Video type", esc(e.videoType)),
    cell("Length", `${fmt(e.durationSec)} <small>· ${e.scenes} scenes, avg ${e.avgSceneSec}s (${e.pacing.minLengthSec}-${e.pacing.maxLengthSec}s)</small>`),
    cell("Scene mix", esc(types)),
    cell("Footage", `${esc(e.footageMode)}<br>${e.stockSources.map((x) => {
      const why = !x.ready ? "no API key in .env" : x.name === "youtube_cc" && !state.status.youtubeCC?.ok ? state.status.youtubeCC?.detail || "unavailable" : "";
      return `<span class="src ${why ? "off" : ""}" title="${esc(why)}">${esc(x.label)}</span>`;
    }).join("")}`),
    cell("Product shots from", esc(e.productSources.join(", ") || "-")),
    cell("Your search edits", `${e.editedScenes} scene(s)`),
    cell("Claude cost so far", cost + (e.footageAgent ? `<br><small>footage agent: ${esc(e.footageAgent)} (small extra)</small>` : "")),
    cell("Estimated time", `≈ ${e.estMinutes.total} min <small>(footage ${e.estMinutes.assets} · render ${e.estMinutes.render})</small>`),
  ].join("");
  box.classList.remove("hidden");
}

$("runAll").onclick = () => run({ from: "transcribe", useLlm: state.status.anthropicKey });
$("rerunStep").onchange = (e) => {
  if (!e.target.value) return;
  run({ from: e.target.value, force: true, useLlm: state.status.anthropicKey });
  e.target.value = "";
};

function startPolling() {
  clearInterval(state.poll);
  const tick = async () => {
    if (!state.current) return;
    const name = state.current;
    const r = await api(`/projects/${encodeURIComponent(name)}/log?since=${state.logTotal}`).catch(() => null);
    if (!r || name !== state.current) return;
    if (r.lines.length) {
      const pre = $("log");
      const atBottom = pre.scrollTop + pre.clientHeight >= pre.scrollHeight - 20;
      pre.textContent += r.lines.join("\n") + "\n";
      if (atBottom) pre.scrollTop = pre.scrollHeight;
    }
    const wasRunning = state.running;
    state.logTotal = r.total;
    state.running = r.running;
    const gateBefore = state.planGate;
    state.planGate = r.planGate;
    $("logState").textContent = r.running ? `· running ${r.step}` : r.failedStep ? `· failed at ${r.failedStep}` : "";
    $("runAll").disabled = r.running;
    renderStepper(r.steps);
    if (r.running) $("logBox").open = true;
    if (wasRunning && !r.running) {
      refreshProjects();
      await loadResults(r.steps);
      toast(r.failedStep ? `Stopped: ${r.failedStep} failed (see log)` : r.awaitingApproval ? "Plan ready - check it and press Approve" : "Pipeline finished");
    } else if (gateBefore !== state.planGate) renderPlanBox();
    if (!r.running && !wasRunning) clearInterval(state.poll);
  };
  tick();
  state.poll = setInterval(tick, 1200);
}

async function loadResults(steps) {
  const name = encodeURIComponent(state.current);
  const get = (f) => api(`/projects/${name}/file/${f}`).catch(() => null);
  state.aligned = steps.align === "done" ? await get("aligned.json") : null;
  state.scenes = steps.plan === "done" ? (await get("scenes.json")) || [] : [];
  state.sections = steps.plan === "done" ? (await get("sections.json")) || [] : [];
  const planReport = steps.plan === "done" ? await get("plan_report.json") : null;
  state.assets = steps.assets === "done" ? await get("assets.json") : null;
  const assetsReport = steps.assets === "done" ? await get("assets_report.json") : null;
  $("stageNote").textContent = state.assets ? "Preview · assets from step 4 (render comes next)" : "Preview · real footage arrives in step 4 (Assets)";
  const drift = await get("drift_report.json");
  const renderReport = steps.render === "done" ? await get("render_report.json") : null;
  renderFinal(renderReport);
  const qaReport = steps.qa === "done" || steps.qa === "failed" ? await get("qa_report.json") : null;
  const approval = await api(`/projects/${name}/approve`).catch(() => ({ approved: false }));
  renderQa(qaReport, approval);

  renderPlanBox();
  const any = state.aligned || state.scenes.length;
  $("reviewArea").classList.toggle("hidden", !any);
  if (!any) return;

  state.duration =
    planReport?.duration ||
    (state.aligned?.words.length ? state.aligned.words[state.aligned.words.length - 1].end + 0.5 : 0);
  buildCaptions();
  stageScene = -2;
  renderStage($("audio").currentTime || 0);
  renderTimeline();
  renderScenes();
  renderTranscript();
  renderStats(planReport, drift, assetsReport);
}

// ---------- final video ----------

function renderFinal(rep) {
  const box = $("finalBox");
  if (!rep || !rep.output || /_firstd+s.mp4$/.test(rep.output)) return box.classList.add("hidden");
  const name = encodeURIComponent(state.current);
  box.classList.remove("hidden");
  $("finalVideo").src = `/api/projects/${name}/video?t=${Date.now()}`;
  $("finalDownload").href = `/api/projects/${name}/video?download=1`;
  $("finalMeta").innerHTML = [
    `${Math.floor(rep.durationVideo / 60)}:${String(Math.round(rep.durationVideo % 60)).padStart(2, "0")} min`,
    `${rep.sizeMB} MB`,
    `rendered in ${rep.renderSeconds}s`,
    rep.sync ? '<span class="ok">A/V in sync</span>' : '<span class="bad">A/V mismatch</span>',
    rep.music ? "music on" : "no music",
    rep.captions ? "captions on" : "captions off",
  ].join(" · ");
  api(`/projects/${name}/approve`).then((ap) => {
    $("finalMeta").innerHTML += ap.approved ? ' · <span class="ok">✓ approved</span>' : ' · <span class="bad">not approved yet (QA tab)</span>';
  }).catch(() => {});
}

// ---------- QA & publish ----------

function copyBtn(id) {
  return `<button class="btn small copy" data-copy="${id}">Copy</button>`;
}

function renderQa(rep, approval) {
  const box = $("qaBox");
  const badge = $("qaBadge");
  if (!rep) {
    badge.textContent = "";
    box.innerHTML = '<p class="muted">Run the pipeline through step 7 (QA) to see checks here.</p>';
    return;
  }
  const s = rep.summary;
  badge.textContent = approval.approved ? "approved" : s.fail ? `${s.fail} fail` : `${s.warn} warn`;
  badge.className = `qa-badge ${approval.approved ? "ok" : s.fail ? "bad" : "warnc"}`;
  const icon = { pass: "✓", warn: "!", fail: "✕" };
  const groups = [...new Set(rep.checks.map((c) => c.group))];
  const gate = approval.approved
    ? `<div class="gate ok">✓ Approved for publish ${new Date(approval.approvedAt).toLocaleString()}${approval.note ? ` - "${esc(approval.note)}"` : ""} <button id="unapprove" class="btn small">Withdraw</button></div>`
    : `<div class="gate ${s.fail ? "bad" : "warnc"}">
        ${approval.stale ? "<b>The video was re-rendered after approval - review it again.</b><br>" : ""}
        ${s.fail ? `<b>${s.fail} failure(s)</b> must be fixed before publishing.` : "Watch the final video, check the warnings, then approve."}
        <div class="gate-row"><input id="approveNote" placeholder="Optional note (what you checked)"><button id="approveBtn" class="btn primary small" ${s.fail ? "disabled" : ""}>Approve for publish</button></div>
      </div>`;
  box.innerHTML = `
    ${gate}
    <p class="muted small">${s.pass} pass · ${s.warn} warnings · ${s.fail} failures · checked ${new Date(rep.createdAt).toLocaleString()}</p>
    <div class="qa-grid">${groups.map((g) => `<div class="card"><h2>${esc(g)}</h2>${rep.checks.filter((c) => c.group === g).map((c) => `<div class="qa-row ${c.status}"><span class="qi">${icon[c.status]}</span><div><b>${esc(c.name)}</b><div class="muted small">${esc(c.detail)}</div></div></div>`).join("")}</div>`).join("")}</div>
    <div class="card pub"><h2>YouTube description ${copyBtn("pubDesc")}</h2><textarea id="pubDesc" rows="14">${esc(rep.publish.description)}</textarea></div>
    <div class="card pub"><h2>Pinned comment ${copyBtn("pubPin")}</h2><textarea id="pubPin" rows="6">${esc(rep.publish.pinnedComment)}</textarea></div>
    <p class="muted small">AI disclosure: ${rep.aiDisclosure.required ? "<b>turn ON</b> YouTube's “altered or synthetic content” label" : esc(rep.aiDisclosure.reason)}. Replace every [PLACEHOLDER] before publishing.</p>`;
  for (const b of box.querySelectorAll(".copy")) {
    b.onclick = async () => {
      await navigator.clipboard.writeText($(b.dataset.copy).value).catch(() => {});
      toast("Copied");
    };
  }
  const name = encodeURIComponent(state.current);
  if ($("approveBtn")) {
    $("approveBtn").onclick = async () => {
      try {
        await api(`/projects/${name}/approve`, { method: "POST", body: JSON.stringify({ note: $("approveNote").value }) });
        toast("Approved for publish");
        renderQa(rep, await api(`/projects/${name}/approve`));
      } catch (e) {
        toast(e.message, true);
      }
    };
  }
  if ($("unapprove")) {
    $("unapprove").onclick = async () => {
      await api(`/projects/${name}/approve`, { method: "DELETE" });
      renderQa(rep, { approved: false });
    };
  }
}

// ---------- timeline + player ----------

function renderTimeline() {
  const tl = $("timeline");
  tl.querySelectorAll(".blk").forEach((b) => b.remove());
  const D = state.duration || 1;
  for (const s of state.scenes) {
    const b = document.createElement("div");
    b.className = `blk ${s.type}`;
    b.style.width = `${(100 * (s.end - s.start)) / D}%`;
    b.title = `#${s.id} ${s.type} ${fmt(s.start)}–${fmt(s.end)}\n${s.text}`;
    b.dataset.id = s.id;
    tl.appendChild(b);
  }
  $("sectionsBar").innerHTML = state.sections
    .map((s) => {
      const label = s.kind === "item" ? `${s.rank !== undefined ? `#${s.rank} ` : ""}${s.product_name || ""}` : s.kind;
      return `<div class="sec" style="left:${(100 * s.start) / D}%;width:${(100 * (s.end - s.start)) / D}%" title="${esc(label)}">${esc(label)}</div>`;
    })
    .join("");
}

$("timeline").onclick = (e) => {
  const r = e.currentTarget.getBoundingClientRect();
  seek(((e.clientX - r.left) / r.width) * state.duration);
};

function seek(t) {
  const a = $("audio");
  a.currentTime = t;
  a.play().catch(() => {});
}

$("audio").ontimeupdate = () => {
  const t = $("audio").currentTime;
  $("nowTime").textContent = fmt(t);
  $("playhead").style.left = `${(100 * t) / (state.duration || 1)}%`;
  const idx = state.scenes.findIndex((s) => t >= s.start && t < s.end);
  if (idx !== state.curScene) {
    state.curScene = idx;
    document.querySelectorAll(".scene.cur, .blk.cur").forEach((el) => el.classList.remove("cur"));
    if (idx >= 0) {
      const s = state.scenes[idx];
      $("nowScene").textContent = `scene #${s.id} · ${s.type}${s.graphic ? ` (${s.graphic.kind})` : ""}`;
      document.querySelector(`.blk[data-id="${idx}"]`)?.classList.add("cur");
      const card = document.querySelector(`.scene[data-id="${idx}"]`);
      if (card) {
        card.classList.add("cur");
        if (!$("tab-scenes").classList.contains("hidden")) card.scrollIntoView({ block: "nearest", behavior: "smooth" });
      }
    }
  }
  highlightWord(t);
};

const mediaUrl = (id, thumb = false) => `/api/projects/${encodeURIComponent(state.current)}/media/${id}${thumb ? "?thumb=1" : ""}`;

// ---------- live preview stage (CapCut-style) ----------

let stageScene = -2;
let captionChunks = [];

/** Clean captions: up to 7 words per line, never crossing a sentence end. */
function buildCaptions() {
  captionChunks = [];
  const words = state.aligned?.words || [];
  let cur = [];
  const flush = () => {
    if (cur.length) captionChunks.push({ start: words[cur[0]].start, end: words[cur[cur.length - 1]].end, idx: cur });
    cur = [];
  };
  words.forEach((w, i) => {
    if (w.source === "extra") return;
    cur.push(i);
    if (cur.length >= 7 || /[.!?]["')\]]*$/.test(w.word)) flush();
  });
  flush();
}

function stageHtml(s) {
  if (!s) return `<div class="stage-scene"><div class="stage-ph"><div class="sub">No scene here</div></div></div>`;
  const g = s.graphic;
  if (s.type === "graphic" && g) {
    if (g.kind === "title_card") {
      return `<div class="stage-scene g-stage"><div class="g-title"><div class="k">Number</div><div class="num">${esc(g.rank ?? "")}</div><div class="name">${esc(g.title)}</div></div></div>`;
    }
    if (g.kind === "price_badge") {
      return `<div class="stage-scene g-stage"><div class="g-price"><div class="t">${esc(g.title)}</div><div class="p">${esc(g.price || "")}</div></div></div>`;
    }
    if (g.kind === "intro_card" || g.kind === "end_card") {
      return `<div class="stage-scene g-stage"><div class="g-title"><div class="k">${g.kind === "intro_card" ? "Today's countdown" : "See you next time"}</div><div class="name">${esc(g.title)}</div></div></div>`;
    }
    const items = (g.lines || [])
      .map((l) => {
        const cls = l.startsWith("+") ? "pro" : l.startsWith("-") ? "con" : "";
        return `<li class="${cls}">${esc(l.replace(/^[+-]\s*/, ""))}</li>`;
      })
      .join("");
    return `<div class="stage-scene g-stage"><div class="g-box"><div class="k">${esc(g.kind.replace("_", " "))}</div><div class="t">${esc(g.title)}</div><ul>${items}</ul></div></div>`;
  }
  const label = s.type === "product" ? "Product footage" : s.type === "image" ? "Still image" : "Stock footage";
  const big = s.type === "product" ? s.product_name : s.queries[0];
  const sub = s.type === "product" ? s.queries.slice(1).join(" · ") : s.queries.slice(1).join(" · ");
  return `<div class="stage-scene"><div class="stage-bg ${s.type}"></div>
    <div class="stage-ph"><div class="film">${s.type === "product" ? "◈" : "▶"}</div><div class="kind">${label}</div><div class="big">${esc(big || "")}</div><div class="sub">${esc(sub)}</div></div></div>`;
}

function assetHtml(s) {
  const a = state.assets?.[s.id];
  if (!a) return null;
  if (a.kind === "video") return `<div class="stage-scene"><video class="stage-media" muted playsinline preload="auto" src="${mediaUrl(s.id)}"></video></div>`;
  return `<div class="stage-scene"><img class="stage-media ${a.source === "graphic" ? "" : "kb"}" src="${mediaUrl(s.id)}" alt=""></div>`;
}

/** Keeps the scene's video in step with the voiceover. */
function syncStageVideo(t) {
  const v = $("stageLayer").querySelector("video");
  const s = state.scenes[stageScene];
  if (!v || !s) return;
  const want = (state.assets?.[s.id]?.in || 0) + (t - s.start);
  if (Math.abs(v.currentTime - want) > 0.35) v.currentTime = want;
  if ($("audio").paused) v.pause();
  else if (v.paused) v.play().catch(() => {});
}

function renderStage(t) {
  const idx = state.scenes.findIndex((s) => t >= s.start && t < s.end);
  if (idx !== stageScene) {
    stageScene = idx;
    const s = state.scenes[idx];
    $("stageLayer").innerHTML = (s && assetHtml(s)) || stageHtml(s);
    $("stagePill").textContent = s ? `#${s.id} · ${s.type}${s.graphic ? " · " + s.graphic.kind : ""} · ${(s.end - s.start).toFixed(1)}s` : "";
  }
  syncStageVideo(t);
  const capOn = $("capToggle").checked && captionChunks.length;
  const cap = $("stageCaption");
  if (!capOn) return cap.classList.add("hidden");
  // Binary search the caption line under the playhead.
  let lo = 0;
  let hi = captionChunks.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (captionChunks[mid].start <= t) lo = mid;
    else hi = mid - 1;
  }
  const c = captionChunks[lo];
  if (!c || t < c.start - 0.15 || t > c.end + 0.6) return cap.classList.add("hidden");
  const words = state.aligned.words;
  cap.innerHTML = c.idx.map((i) => `<span class="${words[i].start <= t ? "on" : ""}">${esc(words[i].word)}</span>`).join(" ");
  cap.classList.remove("hidden");
}

function frame() {
  const a = $("audio");
  renderStage(a.currentTime);
  if (!a.paused) requestAnimationFrame(frame);
}
$("audio").addEventListener("play", () => {
  $("stage").classList.add("playing");
  requestAnimationFrame(frame);
});
$("audio").addEventListener("pause", () => {
  $("stage").classList.remove("playing");
  $("stageLayer").querySelector("video")?.pause();
});
$("audio").addEventListener("seeked", () => renderStage($("audio").currentTime));
$("stagePlay").onclick = () => $("audio").play();
$("stage").addEventListener("click", (e) => {
  if (e.target.id !== "stagePlay" && !$("audio").paused) $("audio").pause();
});
$("capToggle").onchange = () => renderStage($("audio").currentTime);

// ---------- scenes ----------

function thumb(s) {
  const a = state.assets?.[s.id];
  if (a?.thumb) return `<div class="thumb real"><img loading="lazy" src="${mediaUrl(s.id, true)}" alt=""><span class="src ${a.source}">${esc(a.source)}</span></div>`;
  if (s.type !== "graphic" || !s.graphic) {
    const label = s.type === "product" ? s.product_name : s.queries[0];
    return `<div class="thumb ${s.type}">${esc(label || s.type)}</div>`;
  }
  const g = s.graphic;
  let inner = `<div class="gk">${esc(g.kind.replace("_", " "))}</div>`;
  if (g.kind === "title_card") inner += `${g.rank !== undefined ? `<div class="rank">#${esc(g.rank)}</div>` : ""}<div class="gt">${esc(g.title)}</div>`;
  else if (g.kind === "price_badge") inner += `<div class="gt">${esc(g.title)}</div><div class="price">${esc(g.price || "")}</div>`;
  else inner += `<div class="gt">${esc(g.title)}</div><ul>${(g.lines || []).map((l) => `<li>${esc(l)}</li>`).join("")}</ul>`;
  return `<div class="thumb graphic"><div class="gcard">${inner}</div></div>`;
}

function renderScenes() {
  const q = $("sceneFilter").value.toLowerCase();
  const type = $("typeFilter").value;
  const list = state.scenes.filter(
    (s) => (!type || s.type === type) && (!q || `${s.text} ${s.queries.join(" ")} ${s.product_name || ""}`.toLowerCase().includes(q)),
  );
  $("sceneList").innerHTML =
    list
      .map(
        (s) => `<div class="scene" data-id="${s.id}">
          ${thumb(s)}
          <div>
            <div class="meta">
              <b>#${s.id}</b> <span>${fmt(s.start)} – ${fmt(s.end)}</span> <span>${(s.end - s.start).toFixed(1)}s</span>
              <span class="badge ${s.type}">${s.type}</span>
              ${s.graphic ? `<span>${esc(s.graphic.kind)}</span>` : ""}
              ${s.product_name ? `<span>· ${esc(s.product_name)}</span>` : ""}
              <span class="badge llm">${s.labeledBy}</span>
            </div>
            ${state.assets?.[s.id]?.note ? `<div class="note">⚠ ${esc(state.assets[s.id].note)}</div>` : ""}
            <div class="text">${esc(s.text)}</div>
            <div class="qs">${s.queries.map((x) => `<span class="q${s.edited ? " edited" : ""}">${esc(x)}</span>`).join("")}</div>
            ${state.assets && s.type !== "graphic" ? `<button class="btn small swap-btn" data-id="${s.id}">⇄ Swap footage</button>` : ""}
            ${!state.assets && s.type !== "graphic" && !state.running ? `<button class="btn small edit-btn" data-id="${s.id}">✎ Edit searches</button>` : ""}
            <div class="edit-qs hidden" id="edit-${s.id}"></div>
            <div class="swap-panel hidden" id="swap-${s.id}"></div>
          </div>
        </div>`,
      )
      .join("") || `<p class="muted">No scenes${state.scenes.length ? " match the filter" : " yet - run the Plan step"}.</p>`;
  for (const el of $("sceneList").querySelectorAll(".scene")) {
    el.onclick = (e) => {
      if (e.target.closest(".swap-panel, .swap-btn, .edit-btn, .edit-qs")) return;
      seek(state.scenes[Number(el.dataset.id)].start + 0.01);
    };
  }
  for (const b of $("sceneList").querySelectorAll(".swap-btn")) b.onclick = () => toggleSwap(Number(b.dataset.id));
  for (const b of $("sceneList").querySelectorAll(".edit-btn")) b.onclick = () => toggleEdit(Number(b.dataset.id));
}

// ---------- plan review: change a scene's footage searches before approving ----------

function toggleEdit(sceneId) {
  const box = $(`edit-${sceneId}`);
  if (!box.classList.contains("hidden")) return box.classList.add("hidden");
  const s = state.scenes[sceneId];
  box.classList.remove("hidden");
  box.innerHTML = `<input value="${esc(s.queries.join(", "))}" placeholder="e.g. steam locomotive 1920s, railway station crowd" title="Up to 4 searches, separated by commas - the first one matters most">
    <button class="btn small primary">Save</button>${s.edited ? '<button class="btn small reset">Undo edit</button>' : ""}`;
  const input = box.querySelector("input");
  const save = async (queries) => {
    try {
      const r = await api(`/projects/${encodeURIComponent(state.current)}/plan/scene/${sceneId}`, { method: "PUT", body: JSON.stringify({ queries }) });
      state.scenes[sceneId] = { ...state.scenes[sceneId], queries: r.scene.queries, edited: r.scene.edited };
      renderScenes();
      renderPlanBox();
      toast(r.scene.edited ? "Searches saved - approve the plan when ready" : "Edit undone");
    } catch (e) {
      toast(e.message, true);
    }
  };
  box.querySelector(".primary").onclick = () => save(input.value);
  input.onkeydown = (e) => e.key === "Enter" && save(input.value);
  const reset = box.querySelector(".reset");
  if (reset) reset.onclick = () => save([]);
  input.focus();
}
// ---------- scene swap (review page) ----------

function optionHtml(sceneId, c) {
  const cur = state.assets?.[sceneId];
  const isCur = cur && cur.url === c.pageUrl && cur.source === c.source;
  const img = c.thumbUrl ? `<img loading="lazy" src="${esc(c.thumbUrl)}" alt="">` : `<div class="opt-noimg">${esc(c.location.split(/[\\/]/).pop())}</div>`;
  const match = c.match !== undefined && c.match !== null ? ` · match ${Math.round(c.match * 100)}` : "";
  return `<button class="opt${isCur ? " cur" : ""}" data-cand="${esc(c.id)}" title="${esc(c.license)}\n${esc(c.pageUrl)}">
    ${img}<span>${esc(c.source)}${c.kind === "image" ? " · photo" : c.duration ? ` · ${Math.round(c.duration)}s` : ""}${match}${isCur ? " · current" : ""}</span></button>`;
}

async function toggleSwap(sceneId) {
  const panel = $(`swap-${sceneId}`);
  if (!panel.classList.contains("hidden")) return panel.classList.add("hidden");
  panel.classList.remove("hidden");
  panel.innerHTML = `<p class="muted small">Loading options…</p>`;
  const name = encodeURIComponent(state.current);
  const cands = await api(`/projects/${name}/candidates/${sceneId}`).catch(() => []);
  const scene = state.scenes[sceneId];
  panel.innerHTML = `
    <div class="swap-search"><input placeholder="Search other footage…" value="${esc(scene.queries[0] || "")}"><button class="btn small">Search</button></div>
    <div class="opts">${cands.map((c) => optionHtml(sceneId, c)).join("") || '<p class="muted small">No saved options - try a search.</p>'}</div>`;
  const input = panel.querySelector("input");
  const doSearch = async () => {
    const box = panel.querySelector(".opts");
    box.innerHTML = '<p class="muted small">Searching…</p>';
    try {
      const found = await api(`/projects/${name}/candidates/${sceneId}/search`, { method: "POST", body: JSON.stringify({ query: input.value }) });
      box.innerHTML = found.map((c) => optionHtml(sceneId, c)).join("") || '<p class="muted small">Nothing found.</p>';
      bindOptions(panel, sceneId);
    } catch (e) {
      box.innerHTML = `<p class="bad small">${esc(e.message)}</p>`;
    }
  };
  panel.querySelector(".swap-search button").onclick = doSearch;
  input.onkeydown = (e) => e.key === "Enter" && doSearch();
  bindOptions(panel, sceneId);
}

function bindOptions(panel, sceneId) {
  for (const o of panel.querySelectorAll(".opt")) {
    o.onclick = async () => {
      if (state.running) return toast("Wait for the current run to finish", true);
      o.classList.add("busy");
      try {
        await api(`/projects/${encodeURIComponent(state.current)}/swap/${sceneId}`, { method: "POST", body: JSON.stringify({ candId: o.dataset.cand }) });
        toast(`Scene #${sceneId} swapped. Re-rendering only that scene…`);
        $("logBox").open = true;
        startPolling();
      } catch (e) {
        toast(e.message, true);
      } finally {
        o.classList.remove("busy");
      }
    };
  }
}

// ---------- caption fixes ----------

$("transcript").ondblclick = async (e) => {
  const el = e.target.closest(".w[data-i]");
  if (!el) return;
  const i = Number(el.dataset.i);
  const cur = state.aligned.words[i].word;
  const next = prompt("Correct this word (one word):", cur);
  if (next === null || next.trim() === "" || next.trim() === cur) return;
  try {
    await api(`/projects/${encodeURIComponent(state.current)}/words/${i}`, { method: "PUT", body: JSON.stringify({ word: next.trim() }) });
    state.aligned.words[i].word = next.trim();
    state.aligned.words[i].edited = true;
    el.textContent = next.trim();
    el.classList.add("edited");
    buildCaptions();
    $("applyCaptions").classList.remove("hidden");
  } catch (err) {
    toast(err.message, true);
  }
};

$("applyCaptions").onclick = () => {
  $("applyCaptions").classList.add("hidden");
  run({ from: "render", only: true });
  toast("Re-rendering only the scenes whose captions changed…");
};

$("sceneFilter").oninput = renderScenes;
$("typeFilter").onchange = renderScenes;

// ---------- transcript ----------

function renderTranscript() {
  const a = state.aligned;
  if (!a) return ($("transcript").innerHTML = `<p class="muted">Run Align first.</p>`);
  const html = [];
  for (const s of a.sentences) {
    if (s.id === 0 || a.sentences[s.id - 1].paragraph !== s.paragraph) {
      if (s.id) html.push("</p>");
      html.push(`<p><span class="ts">${fmt(s.start)}</span>`);
    }
    for (let i = s.firstWord; i <= s.lastWord; i++) {
      const w = a.words[i];
      const cls = ["w"];
      if (w.source === "glossary" || (w.heard && w.source === "script")) cls.push(w.source === "glossary" ? "glossary" : "");
      if ((w.prob ?? 1) < 0.5) cls.push("low");
      if (w.source === "interpolated") cls.push("interpolated");
      if (w.source === "extra") cls.push("extra");
      if (w.edited) cls.push("edited");
      const title = [w.heard ? `heard: "${w.heard}"` : "", w.prob != null ? `confidence ${w.prob}` : "", `${w.start.toFixed(2)}s`]
        .filter(Boolean)
        .join(" · ");
      html.push(`<span class="${cls.join(" ")}" data-i="${i}" data-t="${w.start}" title="${esc(title)}">${esc(w.word)}</span> `);
    }
  }
  html.push("</p>");
  $("transcript").innerHTML = html.join("");
  $("transcript").onclick = (e) => {
    const t = e.target.dataset?.t;
    if (t) seek(Number(t));
  };
}

let lastWord = -1;
function highlightWord(t) {
  const a = state.aligned;
  if (!a || $("tab-transcript").classList.contains("hidden")) return;
  // Binary search for the word under the playhead.
  let lo = 0;
  let hi = a.words.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (a.words[mid].start <= t) lo = mid;
    else hi = mid - 1;
  }
  if (lo === lastWord) return;
  document.querySelector(`.w[data-i="${lastWord}"]`)?.classList.remove("cur");
  const el = document.querySelector(`.w[data-i="${lo}"]`);
  el?.classList.add("cur");
  el?.scrollIntoView({ block: "nearest" });
  lastWord = lo;
}

// ---------- stats ----------

function table(title, rows) {
  return `<div class="card"><h2>${esc(title)}</h2><table>${rows
    .map(([k, v, cls]) => `<tr><td>${esc(k)}</td><td class="${cls || ""}">${esc(v)}</td></tr>`)
    .join("")}</table></div>`;
}

function renderStats(plan, drift, assetsReport) {
  const cards = [];
  if (state.aligned) {
    cards.push(table(`Align (${state.aligned.mode} mode)`, Object.entries(state.aligned.stats).map(([k, v]) => [k, v])));
    if (state.aligned.corrections.length) {
      cards.push(
        table(
          `Glossary corrections (${state.aligned.corrections.length})`,
          state.aligned.corrections.slice(0, 30).map((c) => [`${fmt(c.start)} "${c.from}"`, c.to]),
        ),
      );
    }
  }
  if (plan) {
    cards.push(
      table("Scene plan", [
        ["valid", plan.valid ? "yes" : "NO", plan.valid ? "ok" : "bad"],
        ["duration", fmt(plan.duration)],
        ["sections", plan.sections],
        ["scenes", plan.scenes],
        ["length min / avg / max", `${plan.minLength} / ${plan.avgLength} / ${plan.maxLength}s`],
        ...Object.entries(plan.types).map(([k, v]) => [`type: ${k}`, v]),
        ["labels by", plan.labeledBy],
        ["LLM cost", `$${plan.llmCostUsd}`],
        ...plan.errors.slice(0, 5).map((e) => ["error", e, "bad"]),
      ]),
    );
  }
  if (drift) {
    cards.push(
      table("Timing drift (vs truth)", [
        ["result", drift.pass ? "PASS" : "FAIL", drift.pass ? "ok" : "bad"],
        ["median start error", `${drift.start.median}s`],
        ["p95 start error", `${drift.start.p95}s`],
        ["max", `${drift.start.max}s`],
        ["word accuracy", `${drift.wordAccuracyPct}%`],
        ["product names", drift.productNamesCorrect],
      ]),
    );
  }
  if (assetsReport) {
    cards.push(
      table("Assets", [
        ["every scene has an asset", assetsReport.valid ? "yes" : "NO", assetsReport.valid ? "ok" : "bad"],
        ...Object.entries(assetsReport.bySource).map(([k, v]) => [`source: ${k}`, v]),
        ["stock clips downloaded", assetsReport.uniqueStockClips],
        ["scenes needing better media", assetsReport.scenesWithNotes],
      ]) + `<p><a class="btn small" href="/api/projects/${encodeURIComponent(state.current)}/license">Download license_log.csv</a></p>`,
    );
  }
  $("stats").innerHTML = cards.join("") || `<p class="muted">No stats yet.</p>`;
}

// ---------- tabs ----------

for (const t of document.querySelectorAll(".tab")) {
  t.onclick = () => {
    document.querySelectorAll(".tab").forEach((x) => x.classList.toggle("active", x === t));
    document.querySelectorAll(".tabpane").forEach((p) => p.classList.toggle("hidden", p.id !== `tab-${t.dataset.tab}`));
    lastWord = -1;
  };
}

window.addEventListener("hashchange", () => {
  const name = decodeURIComponent(location.hash.slice(1));
  if (name && name !== state.current) openProject(name);
});

boot().catch((e) => toast(e.message, true));
