import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { identityText } from "../../domain/product.types.js";
import { secondsToFrame, toNumber } from "../../domain/rational.math.js";
import { clipEnd, MultiTrackTimeline, VideoClip } from "../../domain/timeline.types.js";
import { findVaultFor, harvestKeyword, harvestModel, HarvestOpts, KeywordHarvestOpts, VAULT_ROOT, vaultLicense } from "../../lib/agents/youtube/ytExtractor.js";
import { run } from "../../lib/exec.js";
import { ffmpegPath } from "../../lib/tools.js";
import { EditError, EditOp, findClip, ProjectStore } from "../state/projectStore.js";

/**
 * Editor backend: JSON-RPC 2.0 on POST /api/editor for the block-based multi-track timeline UI
 * (web/editor.html), plus GET /api/editor/thumb for block thumbnails.
 *
 * Methods (params always include `project`):
 *   editor.open                                   -> block view (tracks of blocks, scenes, revision)
 *   editor.edit       {baseRevision, ops[]}       -> apply edits atomically (moveClip, trimEnd, splitClip, deleteClip, setLocked)
 *   editor.undo / editor.redo {baseRevision}
 *   editor.candidates {clipId}                    -> exact-model vault clips for the clip's scene subject
 *   editor.replace    {baseRevision, clipId, candidateId}
 *   editor.fetchNewClip {clipId, keyword?}        -> job id: harvest new exact-model clips from YouTube and hot-swap the best unused one
 *   editor.job        {jobId}                     -> job state / log / result
 *   editor.render     {}                          -> starts an incremental render (only edited scenes re-render)
 */

export interface EditorDeps {
  store: ProjectStore;
  dirOf: (project: string) => string;
  validProject: (project: string) => boolean;
  /** Starts a render of the project (incremental: unchanged scenes come from cache). */
  render: (project: string) => void;
  isBusy: (project: string) => boolean;
  /** Machine category for CLIP prompts ("lawn mower", "drill"...). */
  categoryOf: (project: string) => string;
  harvestModel?: (o: HarvestOpts) => Promise<{ added: number }>;
  harvestKeyword?: (o: KeywordHarvestOpts) => Promise<{ added: number }>;
  vaultRoot?: string;
}

// ---------------------------------------------------------------------------------------------
// JSON-RPC 2.0

export interface RpcRequest {
  jsonrpc: "2.0";
  method: string;
  params?: Record<string, unknown>;
  id?: string | number | null;
}
export interface RpcResponse {
  jsonrpc: "2.0";
  id: string | number | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export const RPC = { PARSE: -32700, INVALID_REQUEST: -32600, NOT_FOUND_METHOD: -32601, INVALID_PARAMS: -32602, INTERNAL: -32603, EDIT_REJECTED: -32000, CONFLICT: -32001, NOT_FOUND: -32002, BUSY: -32003 } as const;

class RpcError extends Error {
  constructor(readonly code: number, message: string) {
    super(message);
  }
}

const str = (p: Record<string, unknown>, k: string) => {
  const v = p[k];
  if (typeof v !== "string" || !v) throw new RpcError(RPC.INVALID_PARAMS, `"${k}" must be a non-empty string`);
  return v;
};
const rev = (p: Record<string, unknown>) => {
  const v = p.baseRevision;
  if (v === undefined || v === null) return null;
  if (typeof v !== "number" || !Number.isInteger(v)) throw new RpcError(RPC.INVALID_PARAMS, `"baseRevision" must be an integer`);
  return v;
};

// ---------------------------------------------------------------------------------------------
// Block view

export interface Block {
  id: string;
  kind: string;
  trackId: string;
  startFrame: number;
  frames: number;
  sceneId?: number;
  label: string;
  source?: string;
  keyword?: string;
  verified?: boolean;
  locked?: boolean;
  mediaKind?: string;
  thumb?: string;
  /** Pictures / voice: seconds into the source file at the block start (preview playback). */
  sourceIn?: number;
  /** Pictures: transition into this block. */
  transition?: string;
  /** Pictures: the file, streamed for the live preview. */
  media?: string;
}

export function blockView(project: string, tl: MultiTrackTimeline, meta: { revision: number; canUndo: boolean; canRedo: boolean; dirty: number[] }) {
  const fr = (t: Parameters<typeof secondsToFrame>[0]) => Number(secondsToFrame(t, tl.fps));
  const q = encodeURIComponent(project);
  return {
    project,
    ...meta,
    fps: toNumber(tl.fps),
    totalFrames: fr(tl.duration),
    scenes: tl.scenes.map((s) => ({
      id: s.id,
      startFrame: fr(s.start),
      frames: fr(clipEnd(s)) - fr(s.start),
      text: s.text,
      subject: { product: s.subject.product ? identityText(s.subject.product) : null, spec: s.subject.spec?.spec ?? null, reason: s.subject.reason },
    })),
    tracks: tl.tracks.map((t) => ({
      id: t.id,
      kind: t.kind,
      name: t.name,
      exclusive: t.exclusive,
      blocks: t.clips.map((c): Block => {
        const base = { id: c.id, kind: c.kind, trackId: t.id, startFrame: fr(c.start), frames: fr(clipEnd(c)) - fr(c.start), ...(c.sceneId !== undefined ? { sceneId: c.sceneId } : {}), ...(c.locked ? { locked: true } : {}) };
        if (c.kind === "video")
          return { ...base, label: c.provenance.keyword ?? path.basename(c.media.path), source: c.provenance.source, ...(c.provenance.keyword ? { keyword: c.provenance.keyword } : {}), ...(c.provenance.verified ? { verified: true } : {}), mediaKind: c.media.kind, thumb: `/api/editor/thumb?project=${q}&clip=${encodeURIComponent(c.id)}`, media: `/api/editor/media?project=${q}&clip=${encodeURIComponent(c.id)}`, sourceIn: toNumber(c.media.sourceIn), transition: c.transitionIn };
        if (c.kind === "overlay") return { ...base, label: c.overlay.card?.comp ?? (c.overlay.video ? "card" : path.basename(c.overlay.path ?? "overlay")) };
        if (c.kind === "sfx") return { ...base, label: c.sfx };
        if (c.kind === "caption") return { ...base, label: c.text };
        return { ...base, label: path.basename(c.media.path), sourceIn: toNumber(c.media.sourceIn) };
      }),
    })),
  };
}

// ---------------------------------------------------------------------------------------------
// Candidates (vault clips for the clip's scene subject)

export interface Candidate {
  id: string;
  kind: "video" | "image";
  path: string;
  url: string;
  channel: string;
  keyword?: string;
  feature?: string | null;
  score: number;
  used: boolean;
  thumbUrl: string;
  license: string;
}

function subjectOfClip(tl: MultiTrackTimeline, clipId: string) {
  const { clip } = findClip(tl, clipId);
  const scene = tl.scenes.find((s) => s.id === clip.sceneId);
  return { clip, scene, subject: scene?.subject };
}

export function candidatesFor(tl: MultiTrackTimeline, clipId: string, root = VAULT_ROOT, keyword?: string): { product: string | null; keyword: string | null; items: Candidate[] } {
  const { clip, subject } = subjectOfClip(tl, clipId);
  if (clip.kind !== "video") throw new EditError("only pictures (B-roll) have candidates");
  const product = subject?.product ? identityText(subject.product) : null;
  const k = (keyword ?? subject?.spec?.spec ?? "").trim().toLowerCase() || null;
  if (!product) return { product: null, keyword: k, items: [] };
  const v = findVaultFor(product, root);
  if (!v) return { product, keyword: k, items: [] };
  const used = new Set(tl.tracks.flatMap((t) => t.clips).filter((c): c is VideoClip => c.kind === "video").map((c) => path.resolve(c.media.path)));
  const items = v.manifest.items
    .filter((i) => fs.existsSync(path.join(v.dir, i.file)))
    .map((i) => ({
      id: i.id,
      kind: i.kind,
      path: path.join(v.dir, i.file),
      url: i.url,
      channel: i.channel,
      ...(i.keyword ? { keyword: i.keyword } : {}),
      feature: i.feature,
      score: i.clipPositive,
      used: used.has(path.resolve(path.join(v.dir, i.file))),
      thumbUrl: `/api/vaults/${encodeURIComponent(path.basename(v.dir))}/thumb/${encodeURIComponent(i.id)}`,
      license: vaultLicense(i, v.manifest.brand),
    }));
  // Unused first, then the spec the scene talks about, then videos, then CLIP score.
  const rank = (c: Candidate) => (c.used ? 10 : 0) - (k && (c.keyword === k || c.feature === k) ? 5 : 0) - (c.kind === "video" ? 1 : 0) - c.score;
  return { product, keyword: k, items: items.sort((a, b) => rank(a) - rank(b)) };
}

const replaceOp = (clipId: string, c: Candidate): EditOp => ({
  op: "replaceMedia",
  clipId,
  media: { path: c.path, kind: c.kind, sourceIn: 0 },
  provenance: { source: "youtube_exact_model", url: c.url, author: c.channel, license: c.license, ...(c.keyword || c.feature ? { keyword: c.keyword ?? c.feature ?? undefined } : {}), confidence: Math.round(c.score * 1000) / 1000, verified: true },
});

/** Edits a client may send to editor.edit (replaceMedia is server-only, via editor.replace). */
const EDIT_OPS = new Set(["moveClip", "trimEnd", "splitClip", "deleteClip", "setLocked", "setTransition", "cutRange"]);

// ---------------------------------------------------------------------------------------------
// Jobs (Fetch New Clip)

export interface Job {
  id: string;
  project: string;
  clipId: string;
  state: "running" | "done" | "failed";
  log: string[];
  result?: { candidateId: string; path: string; revision: number; added: number };
  error?: string;
}

export function createEditorAPI(deps: EditorDeps) {
  const jobs = new Map<string, Job>();
  const root = deps.vaultRoot ?? VAULT_ROOT;
  const hm = deps.harvestModel ?? harvestModel;
  const hk = deps.harvestKeyword ?? harvestKeyword;
  const view = (project: string) => {
    const g = deps.store.get(project);
    return blockView(project, g.tl, { revision: g.revision, canUndo: g.canUndo, canRedo: g.canRedo, dirty: g.dirty });
  };

  async function fetchNewClip(job: Job, keyword?: string): Promise<void> {
    const log = (m: string) => {
      job.log.push(m);
      if (job.log.length > 300) job.log.splice(0, job.log.length - 300);
    };
    try {
      const tl = deps.store.get(job.project).tl;
      const { subject } = subjectOfClip(tl, job.clipId);
      const p = subject?.product;
      if (!p) throw new EditError("this scene has no product subject - the clip cannot be matched to an exact model", "invalid");
      const before = new Set(candidatesFor(tl, job.clipId, root, keyword).items.map((c) => c.id));
      const k = (keyword ?? subject?.spec?.spec ?? "").trim().toLowerCase();
      log(`[fetch] ${identityText(p)}${k ? ` / "${k}"` : ""}: searching YouTube for new exact-model clips`);
      const r = k
        ? await hk({ brand: p.manufacturer, model: p.model, keyword: k, aliases: subject?.spec?.spec === k ? subject.spec.keywords : undefined, category: deps.categoryOf(job.project), log })
        : await hm({ brand: p.manufacturer, model: p.model, category: deps.categoryOf(job.project), log });
      const now = deps.store.get(job.project);
      const list = candidatesFor(now.tl, job.clipId, root, k || undefined).items.filter((c) => !c.used);
      const pick = list.find((c) => !before.has(c.id)) ?? list[0];
      if (!pick) throw new EditError(`no unused clip of ${identityText(p)} found${r.added ? "" : " (nothing new passed the filter)"}`, "not_found");
      const applied = deps.store.apply(job.project, null, [replaceOp(job.clipId, pick)]);
      job.result = { candidateId: pick.id, path: pick.path, revision: applied.revision, added: r.added };
      log(`[fetch] swapped in ${path.basename(pick.path)} (${pick.channel}); ${r.added} new clip(s) in the vault`);
      job.state = "done";
    } catch (err) {
      job.state = "failed";
      job.error = String((err as Error).message ?? err).slice(0, 300);
      log(`[fetch] FAILED: ${job.error}`);
    }
  }

  async function call(method: string, p: Record<string, unknown>): Promise<unknown> {
    if (method === "editor.job") {
      const j = jobs.get(str(p, "jobId"));
      if (!j) throw new RpcError(RPC.NOT_FOUND, "unknown job");
      return { id: j.id, state: j.state, log: j.log.slice(-40), result: j.result ?? null, error: j.error ?? null };
    }
    const project = str(p, "project");
    if (!deps.validProject(project)) throw new RpcError(RPC.INVALID_PARAMS, "project name: letters, digits, - and _ only");
    const editing = ["editor.edit", "editor.undo", "editor.redo", "editor.replace", "editor.fetchNewClip", "editor.render"];
    if (editing.includes(method) && deps.isBusy(project)) throw new RpcError(RPC.BUSY, "the pipeline is running for this project - wait until it finishes");
    switch (method) {
      case "editor.open":
        return view(project);
      case "editor.edit": {
        if (!Array.isArray(p.ops)) throw new RpcError(RPC.INVALID_PARAMS, `"ops" must be an array`);
        // Media can only change through editor.replace (server-listed candidates), never a client path.
        const bad = (p.ops as { op?: unknown }[]).find((o) => !o || typeof o !== "object" || !EDIT_OPS.has(String(o.op)));
        if (bad) throw new RpcError(RPC.INVALID_PARAMS, `op must be one of ${[...EDIT_OPS].join(", ")}`);
        const r = deps.store.apply(project, rev(p), p.ops as EditOp[]);
        return { ...r, view: view(project) };
      }
      case "editor.undo":
        deps.store.undo(project, rev(p));
        return view(project);
      case "editor.redo":
        deps.store.redo(project, rev(p));
        return view(project);
      case "editor.candidates":
        return candidatesFor(deps.store.get(project).tl, str(p, "clipId"), root, typeof p.keyword === "string" ? p.keyword : undefined);
      case "editor.replace": {
        const clipId = str(p, "clipId");
        const cand = candidatesFor(deps.store.get(project).tl, clipId, root).items.find((c) => c.id === str(p, "candidateId"));
        if (!cand) throw new RpcError(RPC.NOT_FOUND, "unknown candidate for this clip (list editor.candidates first)");
        const r = deps.store.apply(project, rev(p), [replaceOp(clipId, cand)]);
        return { ...r, view: view(project) };
      }
      case "editor.fetchNewClip": {
        const clipId = str(p, "clipId");
        findClip(deps.store.get(project).tl, clipId); // 404 early
        const running = [...jobs.values()].find((j) => j.project === project && j.clipId === clipId && j.state === "running");
        if (running) return { jobId: running.id };
        const job: Job = { id: crypto.randomUUID(), project, clipId, state: "running", log: [] };
        jobs.set(job.id, job);
        void fetchNewClip(job, typeof p.keyword === "string" && p.keyword.trim() ? p.keyword : undefined);
        return { jobId: job.id };
      }
      case "editor.render": {
        const scenes = deps.store.takeDirty(project);
        deps.render(project);
        return { started: true, editedScenes: scenes };
      }
      default:
        throw new RpcError(RPC.NOT_FOUND_METHOD, `unknown method ${method}`);
    }
  }

  async function one(req: unknown): Promise<RpcResponse | null> {
    const r = req as Partial<RpcRequest>;
    const id = r && (typeof r.id === "string" || typeof r.id === "number") ? r.id : null;
    if (!r || typeof r !== "object" || r.jsonrpc !== "2.0" || typeof r.method !== "string") return { jsonrpc: "2.0", id, error: { code: RPC.INVALID_REQUEST, message: "invalid JSON-RPC 2.0 request" } };
    const notification = !("id" in r);
    try {
      const params = r.params ?? {};
      if (typeof params !== "object" || Array.isArray(params)) throw new RpcError(RPC.INVALID_PARAMS, "params must be an object");
      const result = await call(r.method, params as Record<string, unknown>);
      return notification ? null : { jsonrpc: "2.0", id, result };
    } catch (err) {
      if (notification) return null;
      const code =
        err instanceof RpcError ? err.code : err instanceof EditError ? (err.code === "conflict" ? RPC.CONFLICT : err.code === "not_found" ? RPC.NOT_FOUND : RPC.EDIT_REJECTED) : RPC.INTERNAL;
      return { jsonrpc: "2.0", id, error: { code, message: String((err as Error).message ?? err).slice(0, 500) } };
    }
  }

  /** Handles a raw request body: one call, a batch, or a parse error. */
  async function handle(body: string): Promise<RpcResponse | RpcResponse[] | null> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      return { jsonrpc: "2.0", id: null, error: { code: RPC.PARSE, message: "parse error" } };
    }
    if (Array.isArray(parsed)) {
      if (!parsed.length) return { jsonrpc: "2.0", id: null, error: { code: RPC.INVALID_REQUEST, message: "empty batch" } };
      const out = (await Promise.all(parsed.map(one))).filter((x): x is RpcResponse => !!x);
      return out.length ? out : null;
    }
    return one(parsed);
  }

  /** Small JPEG of a B-roll clip at its in-point (cached under cache/editor_thumbs). */
  async function thumb(project: string, clipId: string): Promise<string | null> {
    if (!deps.validProject(project)) return null;
    const { clip } = findClip(deps.store.get(project).tl, clipId);
    if (clip.kind !== "video" || !fs.existsSync(clip.media.path)) return null;
    const ff = ffmpegPath();
    if (!ff) return null;
    const st = fs.statSync(clip.media.path);
    const at = clip.media.kind === "video" ? toNumber(clip.media.sourceIn) + 0.3 : 0;
    const key = crypto.createHash("sha1").update(`${path.resolve(clip.media.path)}|${st.mtimeMs}|${at.toFixed(2)}`).digest("hex").slice(0, 16);
    const dir = path.join(deps.dirOf(project), "cache", "editor_thumbs");
    const out = path.join(dir, `${key}.jpg`);
    if (fs.existsSync(out)) return out;
    fs.mkdirSync(dir, { recursive: true });
    const r = await run(ff, ["-v", "error", "-y", ...(clip.media.kind === "video" ? ["-ss", at.toFixed(2)] : []), "-i", clip.media.path, "-frames:v", "1", "-vf", "scale=240:-2", "-q:v", "5", out], { timeoutMs: 60_000 });
    return r.code === 0 && fs.existsSync(out) ? out : null;
  }

  /** A B-roll clip's media file (live preview in the editor). */
  function media(project: string, clipId: string): string | null {
    if (!deps.validProject(project)) return null;
    const { clip } = findClip(deps.store.get(project).tl, clipId);
    return clip.kind === "video" && fs.existsSync(clip.media.path) ? clip.media.path : null;
  }

  return { handle, thumb, media, jobs };
}
