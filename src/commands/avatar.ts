import fs from "node:fs";
import path from "node:path";
import { projectDir, readJson, writeJson } from "../lib/project.js";
import { loadFeatures } from "../lib/settings/features.js";
import { AvatarPlan, channelAvatar, pipLayer, planClips, renderClips } from "../lib/avatar/index.js";
import type { Scene, Section } from "../lib/scenes.js";
import type { Timeline } from "./timeline.js";

/**
 * Step "avatar" (after timeline, before render): plans the avatar clips (intro / outro / bridges),
 * renders them one at a time, then puts them into timeline.json: full frame (the scenes' picture is
 * the avatar) or picture-in-picture (a transparent ProRes layer per scene). Writes avatar_plan.json
 * (QA reads it so the avatar is never reported as a talking head). Off unless features.json
 * avatar.enabled is true (or --force).
 */
export async function avatar(opts: { project: string; force?: boolean }, log: (m: string) => void = console.log): Promise<number> {
  const dir = projectDir(opts.project);
  const cfg = loadFeatures().avatar;
  if (!cfg.enabled && !opts.force) {
    log(`[avatar] off (features.json avatar.enabled = false)`);
    return 0;
  }
  const tlFile = path.join(dir, "timeline.json");
  if (!fs.existsSync(tlFile)) {
    log(`[avatar] ${tlFile} missing. Run timeline first.`);
    return 1;
  }
  const project = readJson<{ audio?: string; channel?: string }>(path.join(dir, "project.json"));
  const channel = project.channel ?? "default";
  const image = channelAvatar(channel);
  if (!image) {
    log(`[avatar] no avatar photo for channel "${channel}": add channels/${channel}/avatar.png (one fixed photo of the presenter you own the rights to)`);
    return 2;
  }
  const tl = readJson<Timeline>(tlFile);
  const voice = tl.voice || project.audio || "";
  if (!voice || !fs.existsSync(voice)) {
    log(`[avatar] voiceover not found (${voice})`);
    return 1;
  }
  const scenes = readJson<Scene[]>(path.join(dir, "scenes.json"));
  const sectionsFile = path.join(dir, "sections.json");
  const sections = fs.existsSync(sectionsFile) ? readJson<Section[]>(sectionsFile) : [];
  // Clip boundaries are the timeline's frame-exact scene boundaries.
  const timed = scenes.map((s) => {
    const t = tl.scenes.find((x) => x.id === s.id);
    return { ...s, start: t ? t.startFrame / 30 : s.start, end: t ? t.endFrame / 30 : s.end };
  });
  const placements = (cfg.placements ?? []).filter((p): p is "intro" | "outro" | "bridge" => p === "intro" || p === "outro" || p === "bridge");
  const plan: AvatarPlan = { engine: cfg.engine, layout: cfg.layout, image, clips: planClips(timed, sections, placements, cfg.maxClipSec) };
  log(`[avatar] ${plan.clips.length} clip(s) planned (${placements.join(", ")}; ${cfg.layout}; max ${cfg.maxClipSec} s) with ${cfg.engine}, photo ${path.relative(process.cwd(), image)}`);
  if (!plan.clips.length) {
    writeJson(path.join(dir, "avatar_plan.json"), plan);
    return 0;
  }
  await renderClips(plan, voice, dir, cfg, log);

  let placed = 0;
  for (const c of plan.clips) {
    if (!c.file) continue;
    for (const id of c.sceneIds) {
      const sc = tl.scenes.find((x) => x.id === id);
      if (!sc) continue;
      const inSec = sc.startFrame / 30 - c.start;
      const dur = (sc.endFrame - sc.startFrame) / 30;
      if (cfg.layout === "full") {
        sc.asset = { path: c.file, kind: "video", source: "own-avatar", in: Math.max(0, Math.round(inSec * 1000) / 1000), duration: c.end - c.start };
        sc.motion = "none";
        delete sc.backdrop;
      } else {
        const layer = path.join(dir, "avatar", `pip_${id}.mov`);
        if (!(await pipLayer(c.file, Math.max(0, inSec), dur, layer, { scale: cfg.pipScale, corner: cfg.pipCorner }))) {
          log(`[avatar] picture-in-picture layer for scene #${id} failed`);
          continue;
        }
        (sc.overlays ??= []).push({ path: layer, delay: 0, anim: "fade", video: true });
      }
      placed++;
    }
  }
  writeJson(tlFile, tl);
  writeJson(path.join(dir, "avatar_plan.json"), { ...plan, source: "own-avatar" });
  const ok = plan.clips.filter((c) => c.file).length;
  log(`[avatar] ${ok}/${plan.clips.length} clip(s) rendered, ${placed} scene(s) updated in timeline.json (${cfg.layout}); render next`);
  return ok === plan.clips.length ? 0 : 3;
}
