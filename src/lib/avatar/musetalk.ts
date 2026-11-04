import { ENGINES, museTalkYaml } from "./engines.js";

/**
 * MuseTalk 1.5 (default avatar engine): real-time lip-sync from one still photo + the clip audio.
 * Setup on this PC: git clone https://github.com/TMElyralab/MuseTalk into avatar.engineDir, create
 * its Python env (avatar.pythonCmd), download the v1.5 weights into models/ (see its README).
 * ~4-6 GB VRAM: fits the 8 GB laptop GPU once the LLM is unloaded (renderClips does that).
 */
export const MUSETALK = ENGINES.musetalk;
export { museTalkYaml };
