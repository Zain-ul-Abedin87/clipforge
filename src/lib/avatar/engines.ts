/**
 * Talking-avatar engines: each is a command run inside the engine's own checkout
 * (features.json avatar.engineDir) with its own Python, ONE CLIP PER PROCESS, so the model leaves
 * VRAM when the clip is done. A template can be overridden in features.json (avatar.command).
 *
 * Placeholders: {python} {image} {audio} {out} {outdir} {face_video} {driving} {fps}
 *  - musetalk (default): real-time lip-sync from a still photo (MuseTalk 1.5, MIT code; check the
 *    model weights' terms). Needs ~4-6 GB VRAM at 256 px faces.
 *  - liveportrait: head motion from a DRIVING VIDEO (features avatar.drivingVideo); it does not
 *    read the audio, so lips only match when the driving clip says the same words. Best paired
 *    with wav2lip afterwards.
 *  - sadtalker / wav2lip / latentsync: optional lip-sync engines.
 *  - hallo2 / echomimic: high quality, very slow on 8 GB (minutes per second of video): optional.
 */

export type AvatarEngineName = "musetalk" | "liveportrait" | "sadtalker" | "wav2lip" | "latentsync" | "hallo2" | "echomimic";

export interface EngineSpec {
  name: AvatarEngineName;
  /** Command template (argv, space-separated; placeholders replaced per clip). */
  command: string;
  /** Where the clip ends up: an exact file ({out}) or the newest .mp4 in {outdir}. */
  output: "out" | "outdir";
  /** Needs a looping face video instead of the still (made from avatar.png with ffmpeg). */
  needsFaceVideo?: boolean;
  /** Ignores the audio (lips do not follow the words): the audio is muxed in afterwards. */
  silent?: boolean;
  slow?: boolean;
  /** Rough VRAM need (GB) for the VRAM guard log. */
  vramGb: number;
}

export const ENGINES: Record<AvatarEngineName, EngineSpec> = {
  musetalk: {
    name: "musetalk",
    // The yaml (one task: the photo + the clip's audio) is written next to {out} by render.ts.
    command: "{python} -m scripts.inference --inference_config {outdir}/task.yaml --result_dir {outdir} --unet_model_path models/musetalkV15/unet.pth --unet_config models/musetalkV15/musetalk.json --version v15 --fps {fps}",
    output: "outdir",
    vramGb: 5,
  },
  liveportrait: { name: "liveportrait", command: "{python} inference.py -s {image} -d {driving} -o {outdir}", output: "outdir", silent: true, vramGb: 4 },
  sadtalker: { name: "sadtalker", command: "{python} inference.py --driven_audio {audio} --source_image {image} --result_dir {outdir} --still --preprocess full", output: "outdir", vramGb: 4 },
  wav2lip: { name: "wav2lip", command: "{python} inference.py --checkpoint_path checkpoints/wav2lip_gan.pth --face {image} --audio {audio} --outfile {out}", output: "out", vramGb: 3 },
  latentsync: { name: "latentsync", command: "{python} -m scripts.inference --unet_config_path configs/unet/stage2.yaml --inference_ckpt_path checkpoints/latentsync_unet.pt --video_path {face_video} --audio_path {audio} --video_out_path {out}", output: "out", needsFaceVideo: true, vramGb: 7 },
  hallo2: { name: "hallo2", command: "{python} scripts/inference_long.py --config configs/inference/long.yaml --source_image {image} --driving_audio {audio} --save_path {outdir}", output: "outdir", slow: true, vramGb: 8 },
  echomimic: { name: "echomimic", command: "{python} infer_audio2vid.py --ref_image {image} --audio {audio} --output {outdir}", output: "outdir", slow: true, vramGb: 8 },
};

/** Splits a template into argv (quotes keep spaces) and fills the placeholders. */
export function buildArgv(template: string, vars: Record<string, string>): string[] {
  const parts = template.match(/"[^"]*"|'[^']*'|\S+/g) ?? [];
  return parts.map((p) => p.replace(/^["']|["']$/g, "").replace(/\{(\w+)\}/g, (_, k: string) => vars[k] ?? `{${k}}`));
}

/** MuseTalk inference config (one task). */
export function museTalkYaml(image: string, audio: string): string {
  const q = (s: string) => JSON.stringify(s.replace(/\\/g, "/"));
  return `task_0:\n  video_path: ${q(image)}\n  audio_path: ${q(audio)}\n`;
}
