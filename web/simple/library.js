// Library page: model vault, press kit, my clips, batch queue, glossary (the footage-source tools
// that used to live in the classic UI). Uses the same /api routes; loaded after simple.js.
(() => {
const libChannel = () => $("#lib-channel").value || "default";
const libToast = (m, err) => window.studioToast?.(m, err);
let libKind = "product";
let libFiles = [];
let batchFiles = [];
let qTimer = null;
let vTimer = null;

function setPane(v) {
  setToggle($("#lib-tabs"), v);
  document.querySelectorAll(".lib-pane").forEach((p) => (p.hidden = p.dataset.pane !== v));
  ({ vault: refreshVaults, presskit: refreshPresskit, music: refreshMusic, clips: refreshClips, batch: pollQueue, glossary: loadGlossary })[v]?.();
}
onToggle($("#lib-tabs"), setPane);

window.showLibrary = async () => {
  $("#page-library").hidden = false;
  const chans = await api("/api/channels").catch(() => []);
  const sel = $("#lib-channel");
  if (!sel.options.length) sel.innerHTML = chans.map((c) => `<option>${esc(c.name ?? c)}</option>`).join("");
  setPane(document.querySelector("#lib-tabs button.on")?.dataset.v || "vault");
};
$("#lib-channel").addEventListener("change", () => setPane(document.querySelector("#lib-tabs button.on")?.dataset.v || "vault"));

// ---------- model vault ----------
async function refreshVaults() {
  const r = await api("/api/vaults").catch(() => null);
  if (!r) return;
  $("#v-policy").textContent = r.genericStock ? "Generic stock: ON" : "Generic stock: OFF (exact-model footage only)";
  $("#v-list").innerHTML = r.vaults.map((v) => `<div class="vault-item">
      <div class="row-between"><div><b>${esc(v.brand)} ${esc(v.model)}</b><span class="help" style="margin:0 0 0 8px">${v.clips} clips, ${v.stills} stills · ${v.stats.talkingHeads} talking heads / ${v.stats.offTopic} off-topic rejected</span></div>
      <button class="btn small ghost" data-more="1" data-brand="${esc(v.brand)}" data-model="${esc(v.model)}">Harvest more</button></div>
      <div class="vault-thumbs">${v.sample.map((id) => `<img loading="lazy" src="/api/vaults/${encodeURIComponent(v.name)}/thumb/${encodeURIComponent(id)}" alt="">`).join("")}</div></div>`).join("")
    || "<p class='help'>No models yet.</p>";
}
$("#v-list").addEventListener("click", (e) => {
  const b = e.target.closest("[data-more]");
  if (b) harvest(b.dataset.brand, b.dataset.model);
});
$("#v-harvest").addEventListener("click", () => harvest($("#v-brand").value.trim(), $("#v-model").value.trim()));
async function harvest(brand, model) {
  if (!brand || !model) return libToast("Enter both the brand and the exact model", true);
  try {
    const r = await api("/api/vaults/harvest", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ brand, model, features: $("#v-features").value, category: $("#v-category").value }) });
    libToast(`${brand} ${model}: harvest started (a few minutes per video)`);
    const log = $("#v-log");
    log.hidden = false;
    clearInterval(vTimer);
    vTimer = setInterval(async () => {
      const j = await api(`/api/vaults/${encodeURIComponent(r.name)}/log`).catch(() => null);
      if (!j) return;
      log.textContent = j.lines.slice(-30).join("\n");
      log.scrollTop = log.scrollHeight;
      if (!j.running) { clearInterval(vTimer); libToast(j.failed ? "Harvest failed - see the log" : "Harvest finished", j.failed); refreshVaults(); }
    }, 2000);
  } catch (err) { libToast(err.message, true); }
}

// ---------- press kit ----------
async function refreshPresskit() {
  const g = await api("/api/glossary").catch(() => "");
  $("#pk-products").innerHTML = String(g).split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith("#")).map((p) => `<option value="${esc(p)}">`).join("");
  const items = await api(`/api/presskit?channel=${encodeURIComponent(libChannel())}`).catch(() => []);
  $("#pk-list").innerHTML = items.map((p) => `<li><b>${esc(p.product)}</b> <span class="help">${p.files.length} file(s)</span>
      <ul>${p.files.map((f) => `<li><span title="${esc(f.url)}">${esc(f.name)}</span> <span class="help">${(f.bytes / 1048576).toFixed(1)} MB</span> <a href="#" data-del-pk="1" data-folder="${esc(p.folder)}" data-file="${esc(f.name)}">remove</a></li>`).join("")}</ul></li>`).join("")
    || "<li class='help'>The press kit is empty.</li>";
}
$("#pk-list").addEventListener("click", async (e) => {
  const a = e.target.closest("[data-del-pk]");
  if (!a) return;
  e.preventDefault();
  await api(`/api/presskit?channel=${encodeURIComponent(libChannel())}&folder=${encodeURIComponent(a.dataset.folder)}&file=${encodeURIComponent(a.dataset.file)}`, { method: "DELETE" }).catch((err) => libToast(err.message, true));
  refreshPresskit();
});
$("#pk-add").addEventListener("click", async () => {
  const b = $("#pk-add");
  b.disabled = true;
  try {
    const r = await api(`/api/presskit?channel=${encodeURIComponent(libChannel())}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ product: $("#pk-product").value, url: $("#pk-url").value, license: $("#pk-license").value }) });
    libToast(`Added (${(r.bytes / 1048576).toFixed(1)} MB)`);
    $("#pk-url").value = "";
    refreshPresskit();
  } catch (err) { libToast(err.message, true); } finally { b.disabled = false; }
});
$("#pk-official").addEventListener("click", async () => {
  const one = $("#pk-product").value.trim();
  if (!one) return libToast("Enter a product name", true);
  const b = $("#pk-official");
  b.disabled = true;
  b.textContent = "Searching...";
  try {
    const r = await api(`/api/presskit/official?channel=${encodeURIComponent(libChannel())}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ products: one.split(",").map((s) => s.trim()).filter(Boolean), force: true }) });
    $("#pk-log").hidden = false;
    $("#pk-log").textContent = r.log.join("\n");
    libToast(`${r.results.filter((x) => x.status === "imported").length}/${r.results.length} product(s) got official photos`);
    refreshPresskit();
  } catch (err) { libToast(err.message, true); } finally { b.disabled = false; b.textContent = "Find official photos"; }
});

// ---------- my clips ----------
function dropZone(zone, input, onFiles) {
  zone.addEventListener("dragover", (e) => { e.preventDefault(); zone.classList.add("over"); });
  zone.addEventListener("dragleave", () => zone.classList.remove("over"));
  zone.addEventListener("drop", (e) => { e.preventDefault(); zone.classList.remove("over"); onFiles([...e.dataTransfer.files]); });
  input.addEventListener("change", (e) => onFiles([...e.target.files]));
}
onToggle($("#lib-kind"), (v) => { libKind = v; $("#lib-label-title").textContent = v === "product" ? "Product (exact name)" : "Keywords (what the clip shows)"; });
dropZone($("#lib-drop"), $("#lib-files"), (files) => {
  libFiles = files;
  $("#lib-drop-text").textContent = files.length ? `${files.length} file(s), ${(files.reduce((s, f) => s + f.size, 0) / 1048576).toFixed(1)} MB` : "Drop clips or photos here";
  $("#lib-drop").classList.toggle("has", files.length > 0);
});
$("#lib-upload").addEventListener("click", async () => {
  const label = $("#lib-label").value.trim();
  const note = $("#lib-note").value.trim();
  if (!libFiles.length) return libToast("Choose files first", true);
  if (!label) return libToast(libKind === "product" ? "Enter the product name" : "Enter a few keywords", true);
  if (!note) return libToast("Enter where the files come from (source / permission)", true);
  const bar = $("#lib-progress");
  bar.hidden = false;
  try {
    for (const [i, f] of libFiles.entries()) await uploadFile(`/api/library?channel=${encodeURIComponent(libChannel())}`, f, { "x-filename": f.name, "x-label": label, "x-note": note, "x-kind": libKind }, (p) => (bar.firstElementChild.style.width = `${(100 * (i + p)) / libFiles.length}%`));
    libToast(`${libFiles.length} file(s) added`);
    libFiles = [];
    $("#lib-drop-text").textContent = "Drop clips or photos here";
    refreshClips();
  } catch (err) { libToast(err.message, true); } finally { bar.hidden = true; bar.firstElementChild.style.width = "0"; }
});
async function refreshClips() {
  const items = await api(`/api/library?channel=${encodeURIComponent(libChannel())}`).catch(() => []);
  $("#lib-list").innerHTML = items.map((p) => `<li><b>${esc(p.label)}</b> <span class="help">${p.files.length} file(s)</span>
      <ul>${p.files.map((f) => `<li><span title="${esc(f.note)}">${esc(f.name)}</span> <span class="help">${(f.bytes / 1048576).toFixed(1)} MB</span> <a href="#" data-del-lib="1" data-folder="${esc(p.folder)}" data-file="${esc(f.name)}">remove</a></li>`).join("")}</ul></li>`).join("")
    || "<li class='help'>No clips yet.</li>";
}
$("#lib-list").addEventListener("click", async (e) => {
  const a = e.target.closest("[data-del-lib]");
  if (!a) return;
  e.preventDefault();
  await api(`/api/library?channel=${encodeURIComponent(libChannel())}&folder=${encodeURIComponent(a.dataset.folder)}&file=${encodeURIComponent(a.dataset.file)}`, { method: "DELETE" }).catch((err) => libToast(err.message, true));
  refreshClips();
});

// ---------- music ----------
const musicUrl = (name) => `/api/channels/${encodeURIComponent(libChannel())}/music?file=${encodeURIComponent(name)}`;
let musicFiles = [];
dropZone($("#mu-drop"), $("#mu-files"), (files) => {
  musicFiles = files;
  $("#mu-drop-text").textContent = files.length ? `${files.length} file(s), ${(files.reduce((n, f) => n + f.size, 0) / 1048576).toFixed(1)} MB` : "Drop music files here";
  $("#mu-drop").classList.toggle("has", files.length > 0);
});
$("#mu-upload").addEventListener("click", async () => {
  const note = $("#mu-note").value.trim();
  if (!musicFiles.length) return libToast("Choose music files first", true);
  if (!note) return libToast("Enter the source or licence of the music", true);
  const bar = $("#mu-progress");
  bar.hidden = false;
  try {
    for (const [i, f] of musicFiles.entries()) await uploadFile(`/api/channels/${encodeURIComponent(libChannel())}/music`, f, { "x-filename": f.name, "x-note": note }, (p) => (bar.firstElementChild.style.width = `${(100 * (i + p)) / musicFiles.length}%`));
    libToast(`${musicFiles.length} track(s) added`);
    musicFiles = [];
    $("#mu-drop-text").textContent = "Drop music files here";
    $("#mu-drop").classList.remove("has");
    refreshMusic();
  } catch (err) { libToast(err.message, true); } finally { bar.hidden = true; bar.firstElementChild.style.width = "0"; }
});
async function refreshMusic() {
  const tracks = await api(`/api/channels/${encodeURIComponent(libChannel())}/music`).catch(() => []);
  $("#mu-list").innerHTML = tracks.map((t) => `<li><div class="row-between"><span><b>${esc(t.name)}</b> <span class="help">${(t.bytes / 1048576).toFixed(1)} MB</span></span>
      <a href="#" data-del-mu="${esc(t.name)}">remove</a></div>
      <div class="help">${t.license ? esc(t.license) : "<b style='color:var(--warn)'>No licence note</b> - upload it again with its source"}</div>
      <audio controls preload="none" src="${musicUrl(t.name)}"></audio></li>`).join("") || "<li class='help'>No music yet.</li>";
}
$("#mu-list").addEventListener("click", async (e) => {
  const a = e.target.closest("[data-del-mu]");
  if (!a) return;
  e.preventDefault();
  await api(`/api/channels/${encodeURIComponent(libChannel())}/music?file=${encodeURIComponent(a.dataset.delMu)}`, { method: "DELETE" }).catch((err) => libToast(err.message, true));
  refreshMusic();
});

// ---------- batch ----------
const stem = (n) => n.replace(/\.[^.]+$/, "");
dropZone($("#b-drop"), $("#b-files"), (files) => {
  batchFiles = files;
  const audio = files.filter((f) => /\.(mp3|wav|m4a)$/i.test(f.name));
  const paired = audio.filter((a) => files.some((s) => /\.txt$/i.test(s.name) && stem(s.name) === stem(a.name))).length;
  $("#b-drop-text").textContent = audio.length ? `${audio.length} voiceover(s), ${paired} with a script` : "Drop voiceovers (and scripts) here";
  $("#b-drop").classList.toggle("has", audio.length > 0);
});
$("#b-add").addEventListener("click", async () => {
  const audio = batchFiles.filter((f) => /\.(mp3|wav|m4a)$/i.test(f.name));
  if (!audio.length) return libToast("Drop voiceovers first", true);
  const bar = $("#b-progress");
  bar.hidden = false;
  const names = [];
  try {
    const taken = new Set((await api("/api/projects")).map((p) => p.name));
    for (const [i, a] of audio.entries()) {
      let name = stem(a.name).replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-|-$/g, "").slice(0, 60) || "video";
      for (let k = 2; taken.has(name); k++) name = `${name.replace(/-\d+$/, "")}-${k}`;
      taken.add(name);
      await uploadFile(`/api/projects/${encodeURIComponent(name)}/audio`, a, { "x-filename": a.name }, () => {});
      const script = batchFiles.find((f) => /\.txt$/i.test(f.name) && stem(f.name) === stem(a.name));
      await api(`/api/projects/${encodeURIComponent(name)}/script`, { method: "PUT", body: script ? await script.text() : "" });
      await api(`/api/projects/${encodeURIComponent(name)}/settings`, { method: "PUT", body: JSON.stringify({ channel: libChannel() }) });
      names.push(name);
      bar.firstElementChild.style.width = `${(100 * (i + 1)) / audio.length}%`;
    }
    await api("/api/queue", { method: "POST", body: JSON.stringify({ projects: names, useLlm: true }) });
    libToast(`${names.length} video(s) queued`);
    batchFiles = [];
    $("#b-drop-text").textContent = "Drop voiceovers (and scripts) here";
    pollQueue();
  } catch (err) { libToast(err.message, true); } finally { bar.hidden = true; bar.firstElementChild.style.width = "0"; }
});
async function pollQueue() {
  clearTimeout(qTimer);
  const q = await api("/api/queue").catch(() => null);
  if (!q) return;
  const label = { queued: "waiting", running: "● in progress", done: "✓ done", failed: "✕ failed" };
  $("#q-list").innerHTML = q.items.map((it) => `<li><a href="#/project/${encodeURIComponent(it.project)}">${esc(it.project)}</a> <span class="help">${label[it.status]}</span>
      ${it.qa ? `<span class="help">${it.qa.fail ? `${it.qa.fail} QA issue(s)` : "QA ok"}</span>` : ""}
      ${it.error ? `<span class="help">${esc(it.error)}</span>` : ""}
      ${it.status === "queued" ? `<a href="#" data-qdel="${it.id}">remove</a>` : ""}
      ${it.status === "failed" || it.status === "done" ? `<a href="#" data-qretry="${it.id}">${it.status === "failed" ? "retry" : "run again"}</a>` : ""}</li>`).join("")
    || "<li class='help'>The queue is empty.</li>";
  const waiting = q.items.filter((x) => x.status === "queued").length;
  $("#q-state").textContent = q.paused ? "(paused)" : q.working ? `(running · ${waiting} waiting)` : waiting ? `(${waiting} waiting)` : "(idle)";
  $("#q-pause").textContent = q.paused ? "Resume" : "Pause";
  $("#q-pause").dataset.paused = q.paused ? "1" : "";
  if ((q.working || waiting) && !$("#page-library").hidden) qTimer = setTimeout(pollQueue, 4000);
}
$("#q-list").addEventListener("click", async (e) => {
  const d = e.target.closest("[data-qdel]");
  const r = e.target.closest("[data-qretry]");
  if (!d && !r) return;
  e.preventDefault();
  if (d) await api(`/api/queue/${d.dataset.qdel}`, { method: "DELETE" }).catch(() => {});
  if (r) await api("/api/queue/retry", { method: "POST", body: JSON.stringify({ id: r.dataset.qretry }) }).catch(() => {});
  pollQueue();
});
$("#q-pause").addEventListener("click", async () => { await api(`/api/queue/${$("#q-pause").dataset.paused ? "resume" : "pause"}`, { method: "POST" }).catch(() => {}); pollQueue(); });
$("#q-clear").addEventListener("click", async () => { await api("/api/queue/clear", { method: "POST" }).catch(() => {}); pollQueue(); });

// ---------- glossary ----------
async function loadGlossary() {
  $("#glossary").value = await api("/api/glossary").catch(() => "");
}
$("#g-save").addEventListener("click", async () => {
  await api("/api/glossary", { method: "PUT", body: $("#glossary").value }).catch((err) => libToast(err.message, true));
  $("#g-msg").textContent = "Saved";
  setTimeout(() => ($("#g-msg").textContent = ""), 2000);
});
})();
