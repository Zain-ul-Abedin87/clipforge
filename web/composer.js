// Prompt composer on the home screen (VidRush-style): "Build me a WW2 [Documentary] with my
// [@ historical] brand profile ... [@ A-roll] narration". Uses the globals from app.js
// ($, state, api, esc, toast, uploadWithProgress, refreshProjects, openProject).

const cp = { audio: null, script: "", useLlm: true, menu: null, at: null };
const TAG_KINDS = {
  type: { cls: "type", title: "Video type", color: "#d4602a" },
  brand: { cls: "brand", title: "Brand profiles", color: "#4c9a5a" },
  aroll: { cls: "aroll", title: "A-roll (narration)", color: "#5b6fd6" },
  footage: { cls: "footage", title: "Footage sources", color: "#8a5cc4" },
};

function cpOptions(kind) {
  if (kind === "type") return (state.niches || []).map((n) => ({ kind, value: n.name, label: n.label, chip: n.label.replace(/\s*\(.*\)$/, ""), hint: n.scenes ? `${n.scenes.minLengthSec}-${n.scenes.maxLengthSec}s shots` : "" }));
  if (kind === "brand") return (state.channels || []).map((c) => ({ kind, value: c.name, label: c.name, hint: "brand profile" }));
  if (kind === "footage") return (state.footageModes || []).map((m) => ({ kind, value: m.name, label: m.label }));
  return [{ kind: "aroll", value: "aroll", label: "A-roll", hint: cp.audio ? cp.audio.name : "attach voiceover" }];
}

const cpTags = () => [...$("cpPrompt").querySelectorAll(".cp-tag")];
const cpTag = (kind) => cpTags().find((t) => t.dataset.kind === kind);

function cpMakeTag(o) {
  const t = document.createElement("span");
  t.className = `cp-tag ${TAG_KINDS[o.kind].cls}`;
  t.contentEditable = "false";
  t.dataset.kind = o.kind;
  t.dataset.value = o.value;
  const name = o.chip ?? o.label;
  t.dataset.text = o.kind === "type" ? name : `@${name}`;
  t.title = o.kind === "aroll" ? "Narration - click to change the voiceover" : `${TAG_KINDS[o.kind].title} - click to change`;
  t.innerHTML = `<span>${esc(o.kind === "type" ? name : `@ ${name}`)}</span>${o.kind === "type" ? '<span class="ico">✎</span>' : ""}`;
  return t;
}

/** Puts a tag where "@query" was typed (or at the caret). One tag per kind: a new one replaces the old. */
function cpInsertTag(o, replaceEl) {
  const tag = cpMakeTag(o);
  if (replaceEl) {
    replaceEl.replaceWith(tag);
  } else {
    cpTag(o.kind)?.remove();
    const sel = window.getSelection();
    let range = null;
    if (cp.at && cp.at.node.isConnected) {
      range = document.createRange();
      range.setStart(cp.at.node, cp.at.start);
      range.setEnd(cp.at.node, Math.min(cp.at.end, cp.at.node.length));
      range.deleteContents();
    } else if (sel.rangeCount && $("cpPrompt").contains(sel.anchorNode)) {
      range = sel.getRangeAt(0);
    } else {
      range = document.createRange();
      range.selectNodeContents($("cpPrompt"));
      range.collapse(false);
    }
    range.insertNode(tag);
    const space = document.createTextNode(" ");
    tag.after(space);
    range.setStartAfter(space);
    range.collapse(true);
    sel.removeAllRanges();
    sel.addRange(range);
  }
  cp.at = null;
  if (o.kind === "aroll" && !cp.audio) $("cpAudioFile").click();
  cpRenderAttached();
}

function cpCloseMenu() {
  $("cpMenu").classList.add("hidden");
  $("cpPlus").setAttribute("aria-expanded", "false");
  cp.menu = null;
}

/** items: {group} headings or {label, hint, icon|color, run}. Positioned under `rect`. */
function cpShowMenu(items, rect, kind) {
  const m = $("cpMenu");
  const runnable = items.filter((i) => i.run);
  if (!runnable.length) return cpCloseMenu();
  m.innerHTML = items
    .map((i) =>
      i.group
        ? `<div class="grp">${esc(i.group)}</div>`
        : `<button data-i="${runnable.indexOf(i)}" role="menuitem">${i.icon !== undefined ? `<span class="mi">${i.icon}</span>` : `<span class="dot" style="background:${i.color}"></span>`}<span>${esc(i.label)}</span>${i.hint ? `<small>${esc(i.hint)}</small>` : ""}</button>`,
    )
    .join("");
  m.querySelectorAll("button").forEach((b) => {
    b.onmousedown = (e) => e.preventDefault(); // keep the caret in the prompt
    b.onclick = () => {
      const it = runnable[Number(b.dataset.i)];
      cpCloseMenu();
      it.run();
    };
  });
  cp.menu = { kind, items: runnable, active: 0 };
  cpHighlight();
  m.classList.remove("hidden");
  const host = $("empty").getBoundingClientRect();
  const left = Math.min(rect.left - host.left, host.width - m.offsetWidth - 4);
  m.style.left = `${Math.max(0, left)}px`;
  m.style.top = `${rect.bottom - host.top + 6}px`;
}

function cpHighlight() {
  $("cpMenu").querySelectorAll("button").forEach((b, i) => b.classList.toggle("active", i === cp.menu?.active));
  $("cpMenu").querySelector("button.active")?.scrollIntoView({ block: "nearest" });
}

/** "@his" right before the caret opens the mention menu filtered by "his". */
function cpCheckMention() {
  const sel = window.getSelection();
  const node = sel.anchorNode;
  const inPrompt = sel.rangeCount && sel.isCollapsed && node && node.nodeType === 3 && $("cpPrompt").contains(node);
  const m = inPrompt ? node.textContent.slice(0, sel.anchorOffset).match(/(^|[\s ])@([\w-]{0,30})$/) : null;
  if (!m) {
    cp.at = null;
    if (cp.menu?.kind === "mention") cpCloseMenu();
    return;
  }
  const q = m[2].toLowerCase();
  cp.at = { node, start: sel.anchorOffset - m[2].length - 1, end: sel.anchorOffset };
  const items = [];
  for (const kind of ["brand", "aroll", "type", "footage"]) {
    const opts = cpOptions(kind).filter((o) => !q || o.label.toLowerCase().includes(q) || o.value.toLowerCase().includes(q));
    if (!opts.length) continue;
    items.push({ group: TAG_KINDS[kind].title });
    for (const o of opts) items.push({ label: o.label, hint: o.hint, color: TAG_KINDS[kind].color, run: () => cpInsertTag(o) });
  }
  const r = sel.getRangeAt(0).getBoundingClientRect();
  cpShowMenu(items, r.height ? r : $("cpPrompt").getBoundingClientRect(), "mention");
}

function cpRenderAttached() {
  const parts = [];
  if (cp.audio) parts.push(`<span class="cp-file" title="Voiceover (A-roll)">🎙 <span>${esc(cp.audio.name)}</span><button data-x="audio" aria-label="Remove audio">×</button></span>`);
  if (cp.script.trim()) parts.push(`<span class="cp-file" title="${esc(cp.script.slice(0, 300))}">📄 <span>Script · ${cp.script.trim().split(/\s+/).length} words</span><button data-x="script" aria-label="Remove script">×</button></span>`);
  $("cpAttached").innerHTML = parts.join("");
  $("cpAttached").querySelectorAll("button").forEach((b) => {
    b.onclick = () => {
      if (b.dataset.x === "audio") {
        cp.audio = null;
        $("cpAudioFile").value = "";
        cpTag("aroll")?.remove();
      } else cp.script = "";
      cpRenderAttached();
    };
  });
}

/** Prompt as plain text with tags as words: "Build me a WW2 Documentary ... use my @historical ...". */
function cpText() {
  let out = "";
  const walk = (n) => {
    for (const c of n.childNodes) {
      if (c.nodeType === 3) out += c.textContent;
      else if (c.classList?.contains("cp-tag")) out += c.dataset.text;
      else if (c.nodeName === "BR") out += "\n";
      else {
        if (c.nodeName === "DIV" && out && !out.endsWith("\n")) out += "\n";
        walk(c);
      }
    }
  };
  walk($("cpPrompt"));
  return out.replace(/ /g, " ").replace(/[ \t]+/g, " ").trim();
}

const STOP = new Set(["build", "me", "a", "an", "the", "make", "create", "video", "in", "use", "my", "with", "of", "and", "for", "to", "please"]);
function cpProjectName(text) {
  const words = text.replace(/@\S+/g, " ").toLowerCase().replace(/[^a-z0-9\s-]/g, " ").split(/\s+/).filter((w) => w && !STOP.has(w));
  const d = new Date();
  const two = (n) => String(n).padStart(2, "0");
  return `${words.slice(0, 4).join("-").slice(0, 40) || "video"}-${two(d.getMonth() + 1)}${two(d.getDate())}-${two(d.getHours())}${two(d.getMinutes())}`;
}

async function cpSend() {
  const brief = cpText();
  if (!brief) return toast("Describe the video first", true);
  if (!cp.audio) {
    toast("Add the voiceover first: + → Custom Audio (script-to-voice is not built yet)", true);
    return cpPlusMenu();
  }
  const niche = cpTag("type")?.dataset.value || $("newNiche").value;
  const channel = cpTag("brand")?.dataset.value || $("newChannel").value || "default";
  const footage = cpTag("footage")?.dataset.value || $("newFootage").value;
  const name = cpProjectName(brief);
  const btn = $("cpSend");
  btn.disabled = true;
  btn.textContent = "…";
  try {
    await uploadWithProgress(`/api/projects/${encodeURIComponent(name)}/audio`, cp.audio);
    if (cp.script.trim()) await api(`/projects/${encodeURIComponent(name)}/script`, { method: "PUT", body: cp.script });
    await api(`/projects/${encodeURIComponent(name)}/settings`, { method: "PUT", body: JSON.stringify({ channel, niche, footage, planGate: true, brief }) });
    await api(`/projects/${encodeURIComponent(name)}/run`, { method: "POST", body: JSON.stringify({ from: "transcribe", useLlm: cp.useLlm }) });
    toast("Started. You will see the plan before footage is fetched.");
    cp.audio = null;
    cp.script = "";
    $("cpAudioFile").value = "";
    $("cpPrompt").innerHTML = "";
    cpRenderAttached();
    await refreshProjects();
    openProject(name);
  } catch (e) {
    toast(e.message, true);
  } finally {
    btn.disabled = false;
    btn.textContent = "↑";
  }
}

function cpPlusMenu() {
  $("cpPlus").setAttribute("aria-expanded", "true");
  cpShowMenu(
    [
      { label: "Custom Script", icon: "▤", hint: cp.script.trim() ? "attached" : "", run: cpOpenScript },
      { label: "Custom Audio", icon: "🎙", hint: cp.audio ? "attached" : "", run: () => $("cpAudioFile").click() },
    ],
    $("cpPlus").getBoundingClientRect(),
    "plus",
  );
}

function cpOpenScript() {
  $("cpScriptText").value = cp.script;
  $("cpScriptModal").classList.remove("hidden");
  $("cpScriptText").focus();
}

function cpModelMenu() {
  const opts = [
    { label: "Claude Haiku", hint: "AI scene labels + footage agent", llm: true },
    { label: "Rules only", hint: "no AI calls, free", llm: false },
  ].filter((o) => !o.llm || state.status.anthropicKey);
  cpShowMenu(
    opts.map((o) => ({
      label: o.label,
      hint: o.hint,
      icon: cp.useLlm === o.llm ? "✓" : "",
      run: () => {
        cp.useLlm = o.llm;
        $("cpModelLabel").textContent = o.label;
      },
    })),
    $("cpModel").getBoundingClientRect(),
    "model",
  );
}

function initComposer() {
  const p = $("cpPrompt");
  cp.useLlm = !!state.status.anthropicKey;
  $("cpModelLabel").textContent = cp.useLlm ? "Claude Haiku" : "Rules only";

  p.addEventListener("input", () => {
    if (!p.textContent.trim() && !p.querySelector(".cp-tag")) p.innerHTML = ""; // brings the placeholder back
    cpCheckMention();
  });
  p.addEventListener("keyup", (e) => {
    if (!["ArrowDown", "ArrowUp", "Enter", "Escape", "Tab"].includes(e.key)) cpCheckMention();
  });
  p.addEventListener("keydown", (e) => {
    if (cp.menu) {
      const n = cp.menu.items.length;
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        cp.menu.active = (cp.menu.active + (e.key === "ArrowDown" ? 1 : n - 1)) % n;
        return cpHighlight();
      }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        const it = cp.menu.items[cp.menu.active];
        cpCloseMenu();
        return it.run();
      }
      if (e.key === "Escape") return cpCloseMenu();
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      cpSend();
    }
  });
  // Paste as plain text (no fonts/colours from other sites).
  p.addEventListener("paste", (e) => {
    e.preventDefault();
    document.execCommand("insertText", false, e.clipboardData.getData("text/plain"));
  });
  p.addEventListener("click", (e) => {
    const tag = e.target.closest(".cp-tag");
    if (!tag) return;
    const kind = tag.dataset.kind;
    if (kind === "aroll") return $("cpAudioFile").click();
    cp.at = null;
    cpShowMenu(
      cpOptions(kind).map((o) => ({ label: o.label, hint: o.hint, color: TAG_KINDS[kind].color, run: () => cpInsertTag(o, tag) })),
      tag.getBoundingClientRect(),
      "change",
    );
  });

  $("cpPlus").onclick = (e) => {
    e.stopPropagation();
    cp.menu?.kind === "plus" ? cpCloseMenu() : cpPlusMenu();
  };
  $("cpModel").onclick = (e) => {
    e.stopPropagation();
    cp.menu?.kind === "model" ? cpCloseMenu() : cpModelMenu();
  };
  $("cpSend").onclick = cpSend;
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    if (cp.menu) cpCloseMenu();
    $("cpScriptModal").classList.add("hidden");
  });
  document.addEventListener("mousedown", (e) => {
    if (cp.menu && !$("cpMenu").contains(e.target) && !e.target.closest("#cpPlus, #cpModel, .cp-tag")) cpCloseMenu();
  });

  $("cpAudioFile").onchange = () => {
    const f = $("cpAudioFile").files[0];
    if (!f) return;
    cp.audio = f;
    if (!cpTag("aroll")) {
      const tag = cpMakeTag(cpOptions("aroll")[0]);
      if (p.textContent.trim()) p.append(" ", tag, " ");
      else p.append(tag, " ");
    }
    cpRenderAttached();
  };

  $("cpScriptClose").onclick = () => $("cpScriptModal").classList.add("hidden");
  $("cpScriptModal").onclick = (e) => e.target === $("cpScriptModal") && $("cpScriptModal").classList.add("hidden");
  $("cpScriptLoad").onclick = () => $("cpScriptFile").click();
  $("cpScriptFile").onchange = async () => {
    const f = $("cpScriptFile").files[0];
    if (f) $("cpScriptText").value = await f.text();
    $("cpScriptFile").value = "";
  };
  $("cpScriptSave").onclick = () => {
    cp.script = $("cpScriptText").value;
    $("cpScriptModal").classList.add("hidden");
    cpRenderAttached();
  };

  // Logo -> back to the composer.
  const brand = document.querySelector(".brand");
  brand.style.cursor = "pointer";
  brand.title = "New video";
  brand.onclick = () => {
    state.current = null;
    history.replaceState(null, "", location.pathname);
    $("projectView").classList.add("hidden");
    $("empty").classList.remove("hidden");
    p.focus();
  };
}
