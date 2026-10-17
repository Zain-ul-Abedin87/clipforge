import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { alignTokens, Discrepancy, findDiscrepancies, Resolution, RESOLUTIONS } from "../lib/align.js";
import { applyGlossary, Correction, loadGlossary, TimedWord } from "../lib/glossary.js";
import { paths } from "../lib/paths.js";
import { fingerprint, isCached, markDone, projectDir, readJson, writeJson } from "../lib/project.js";
import { endsSentence, norm, tokenize } from "../lib/text.js";
import { applyWordEdits } from "../lib/wordEdits.js";

export type WordSource = "script" | "whisper" | "glossary" | "interpolated" | "extra";

export interface AlignedWord {
  word: string;
  start: number;
  end: number;
  source: WordSource;
  /** Corrected by hand in the review page. */
  edited?: boolean;
  /** What Whisper actually heard, when it differs from `word`. */
  heard?: string;
  prob?: number;
}

export interface Sentence {
  id: number;
  text: string;
  start: number;
  end: number;
  firstWord: number;
  lastWord: number;
  paragraph: number;
}

export interface Aligned {
  mode: "script" | "transcript";
  words: AlignedWord[];
  sentences: Sentence[];
  corrections: Correction[];
  stats: Record<string, number>;
  /** Mode C: every place the voiceover and the script disagree (script mode only). */
  discrepancies?: Discrepancy[];
}

/** Resolutions chosen in the review page, kept in the project manifest (project.json discrepancyResolutions). */
export function loadResolutions(dir: string): Record<string, Resolution> {
  const f = path.join(dir, "project.json");
  if (!fs.existsSync(f)) return {};
  const raw = readJson<{ discrepancyResolutions?: Record<string, string> }>(f).discrepancyResolutions ?? {};
  return Object.fromEntries(Object.entries(raw).filter(([, v]) => (RESOLUTIONS as readonly string[]).includes(v))) as Record<string, Resolution>;
}

export function saveResolution(dir: string, id: string, resolution: Resolution | null): void {
  const f = path.join(dir, "project.json");
  const cur = fs.existsSync(f) ? readJson<Record<string, unknown>>(f) : {};
  const res = { ...((cur.discrepancyResolutions as Record<string, string> | undefined) ?? {}) };
  if (resolution) res[id] = resolution;
  else delete res[id];
  fs.writeFileSync(f, JSON.stringify({ ...cur, discrepancyResolutions: res }, null, 2));
}

export interface AlignOpts {
  project: string;
  script?: string;
  noScript?: boolean;
  glossary?: string;
  force?: boolean;
}

const LOW_PROB = 0.5;
const round = (x: number) => Math.round(x * 1000) / 1000;

export async function align(opts: AlignOpts): Promise<number> {
  const dir = projectDir(opts.project);
  const wordsFile = path.join(dir, "words.json");
  if (!fs.existsSync(wordsFile)) {
    console.error(`[align] ${wordsFile} missing. Run \`clipforge transcribe\` first.`);
    return 1;
  }

  const defaultScript = path.join(paths.inputs, "script.txt");
  const script = opts.noScript
    ? null
    : opts.script
      ? path.resolve(opts.script)
      : fs.existsSync(defaultScript)
        ? defaultScript
        : null;
  const glossaryFile = opts.glossary ? path.resolve(opts.glossary) : path.join(paths.inputs, "glossary.txt");
  const inputs = {
    words: fingerprint(wordsFile),
    script: fingerprint(script),
    glossary: fingerprint(glossaryFile),
    edits: fingerprint(path.join(dir, "word_edits.json")),
    resolutions: crypto.createHash("sha1").update(JSON.stringify(loadResolutions(dir))).digest("hex"),
  };

  if (!opts.force && isCached(dir, "align", inputs, ["aligned.json"])) {
    console.log(`[align] cached -> ${path.join(dir, "aligned.json")} (use --force to redo)`);
    return 0;
  }

  const raw = readJson<TimedWord[]>(wordsFile);
  const { words: whisper, corrections } = applyGlossary(raw, loadGlossary(glossaryFile));

  const result = script
    ? alignToScript(fs.readFileSync(script, "utf8"), whisper, corrections, loadResolutions(dir))
    : transcriptOnly(whisper, corrections);

  // "modify_script": the user decided the voiceover is right and the script should say the same.
  // Only the project's own script.txt is rewritten (a backup is kept); inputs/ files are never touched.
  const modify = (result.discrepancies ?? []).filter((d) => d.resolution === "modify_script");
  if (script && modify.length) {
    if (path.resolve(path.dirname(script)) === path.resolve(dir)) {
      const original = fs.readFileSync(script, "utf8");
      fs.writeFileSync(path.join(dir, `script.before-modify.${Date.now()}.txt`), original);
      fs.writeFileSync(script, rewriteScript(original, result.discrepancies!) + "\n");
      inputs.script = fingerprint(script);
      console.log(`[align] script.txt updated to match the voiceover (${modify.length} change(s), backup kept)`);
    } else console.warn(`[align] modify_script ignored: ${script} is outside the project folder`);
  }

  // Hand corrections from the review page survive a re-run of this step.
  const edited = applyWordEdits(dir, result.words);
  if (edited) {
    for (const st of result.sentences) st.text = result.words.slice(st.firstWord, st.lastWord + 1).map((w) => w.word).join(" ");
    console.log(`[align] kept ${edited} hand-corrected word(s)`);
  }
  writeJson(path.join(dir, "aligned.json"), result);
  if (result.discrepancies) writeJson(path.join(dir, "discrepancies.json"), { generatedAt: new Date().toISOString(), script, items: result.discrepancies });
  else fs.rmSync(path.join(dir, "discrepancies.json"), { force: true });
  markDone(dir, "align", inputs);

  console.log(`[align] mode=${result.mode}${script ? ` script=${script}` : ""}`);
  for (const [k, v] of Object.entries(result.stats)) console.log(`[align]   ${k.padEnd(22)} ${v}`);
  const sig = (result.discrepancies ?? []).filter((d) => d.severity === "significant");
  if (sig.length) {
    console.log(`[align] ${sig.length} significant script/voiceover discrepancies (${sig.filter((d) => !d.resolution).length} unresolved):`);
    for (const d of sig.slice(0, 15)) console.log(`[align]   ${fmt(d.start)} ${d.type} [${d.reasons.join(",")}] script "${d.script}" / heard "${d.heard}"${d.resolution ? ` -> ${d.resolution}` : ""}`);
  }
  if (corrections.length) {
    console.log(`[align] glossary corrections (${corrections.length}):`);
    for (const c of corrections.slice(0, 15)) console.log(`[align]   ${fmt(c.start)}  "${c.from}" -> "${c.to}"`);
    if (corrections.length > 15) console.log(`[align]   ... ${corrections.length - 15} more in aligned.json`);
  }
  console.log(`[align] wrote ${path.join(dir, "aligned.json")}`);
  return 0;
}

/** Script tokens with their paragraph number (paragraphs are blank-line separated). */
function scriptTokens(scriptText: string): { word: string; paragraph: number }[] {
  const tokens: { word: string; paragraph: number }[] = [];
  scriptText
    .replace(/\r/g, "")
    .split(/\n\s*\n/)
    .forEach((para, p) => tokenize(para).forEach((word) => tokens.push({ word, paragraph: p })));
  return tokens;
}

/**
 * Script mode: script spelling is the truth, Whisper supplies the timing. Where the two disagree
 * (Mode C discrepancies) the user's resolution decides what the captions show:
 * keep_audio / modify_script -> the spoken words; correct_transcript -> the script words, ad-libs dropped;
 * unresolved -> script words, ad-libs kept and flagged (the old behaviour).
 */
export function alignToScript(scriptText: string, whisper: TimedWord[], corrections: Correction[], resolutions: Record<string, Resolution> = {}): Aligned {
  const tokens = scriptTokens(scriptText);
  const pathPairs = alignTokens(tokens.map((t) => norm(t.word)), whisper.map((w) => norm(w.word)));
  const discrepancies = findDiscrepancies(tokens.map((t) => t.word), whisper, pathPairs);
  const runOf = new Map<number, Discrepancy>();
  for (const d of discrepancies) {
    if (resolutions[d.id]) d.resolution = resolutions[d.id];
    for (let k = d.pairRange[0]; k <= d.pairRange[1]; k++) runOf.set(k, d);
  }

  const words: (AlignedWord & { paragraph: number; scriptToken: boolean })[] = [];
  const stats = { scriptWords: tokens.length, whisperWords: whisper.length, exact: 0, fuzzy: 0, substituted: 0, interpolated: 0, extraHeard: 0 };

  for (const [k, p] of pathPairs.entries()) {
    const res = runOf.get(k)?.resolution;
    if (res === "keep_audio" || res === "modify_script") {
      // The voiceover wins: show what was said; script words that were not spoken are dropped.
      if (p.b >= 0) {
        const w = whisper[p.b];
        const para = p.a >= 0 ? tokens[p.a].paragraph : words.length ? words[words.length - 1].paragraph : 0;
        words.push({ word: w.word, start: w.start, end: w.end, source: "whisper", prob: w.prob, paragraph: para, scriptToken: true });
      }
      continue;
    }
    if (p.a < 0 && res === "correct_transcript") continue; // the user says this "extra" was a mishearing
    if (p.a >= 0) {
      const t = tokens[p.a];
      if (p.b >= 0) {
        const w = whisper[p.b];
        if (p.kind === "match") stats.exact++;
        else if (p.kind === "similar") stats.fuzzy++;
        else stats.substituted++;
        words.push({
          word: t.word, start: w.start, end: w.end, source: "script", prob: w.prob,
          ...(p.kind !== "match" ? { heard: w.word } : {}),
          paragraph: t.paragraph, scriptToken: true,
        });
      } else {
        stats.interpolated++;
        words.push({ word: t.word, start: NaN, end: NaN, source: "interpolated", paragraph: t.paragraph, scriptToken: true });
      }
    } else {
      // Spoken but not in the script (ad-lib or Whisper hallucination). Kept, flagged for review.
      stats.extraHeard++;
      const w = whisper[p.b];
      const para = words.length ? words[words.length - 1].paragraph : 0;
      words.push({ word: w.word, start: w.start, end: w.end, source: "extra", prob: w.prob, paragraph: para, scriptToken: false });
    }
  }

  interpolateGaps(words);

  // Sentences come from the script's own punctuation; extras never end a sentence.
  const sentences: Sentence[] = [];
  let first = 0;
  for (let i = 0; i < words.length; i++) {
    const last = i === words.length - 1;
    const breakHere = words[i].scriptToken && endsSentence(words[i].word);
    const paraChange = !last && words[i + 1].paragraph !== words[i].paragraph;
    if (breakHere || paraChange || last) {
      sentences.push(makeSentence(sentences.length, words, first, i, words[first].paragraph));
      first = i + 1;
    }
  }

  const clean = words.map(({ paragraph: _p, scriptToken: _s, ...w }) => w);
  return {
    mode: "script",
    words: clean,
    sentences,
    corrections,
    stats: {
      ...stats,
      matchRatePct: round((100 * (stats.exact + stats.fuzzy)) / Math.max(1, tokens.length)),
      lowConfidence: clean.filter((w) => (w.prob ?? 1) < LOW_PROB).length,
      sentences: sentences.length,
      discrepancies: discrepancies.length,
      significantDiscrepancies: discrepancies.filter((d) => d.severity === "significant").length,
      unresolvedSignificant: discrepancies.filter((d) => d.severity === "significant" && !d.resolution).length,
    },
    discrepancies,
  };
}

/** The script with every "modify_script" discrepancy replaced by what was spoken (paragraphs kept). */
export function rewriteScript(scriptText: string, discrepancies: Discrepancy[]): string {
  const tokens = scriptTokens(scriptText);
  const replaced = new Map<number, string>(); // script token index -> new text ("" = drop)
  const inserted = new Map<number, string>(); // spoken text added before script token index
  for (const d of discrepancies.filter((x) => x.resolution === "modify_script")) {
    if (d.scriptRange) {
      for (let k = d.scriptRange[0]; k <= d.scriptRange[1]; k++) replaced.set(k, k === d.scriptRange[0] ? d.heard : "");
    } else if (d.insertAt !== undefined) inserted.set(d.insertAt, [inserted.get(d.insertAt), d.heard].filter(Boolean).join(" "));
  }
  const paras: string[][] = [];
  tokens.forEach((t, k) => {
    const para = (paras[t.paragraph] ??= []);
    if (inserted.has(k)) para.push(inserted.get(k)!);
    const text = replaced.has(k) ? replaced.get(k)! : t.word;
    if (text) para.push(text);
  });
  if (inserted.has(tokens.length) && paras.length) paras[paras.length - 1].push(inserted.get(tokens.length)!);
  return paras.filter((p) => p && p.length).map((p) => p.join(" ")).join("\n\n");
}

/** Voice-only mode: Whisper text (after glossary fixes) is the transcript. */
function transcriptOnly(whisper: TimedWord[], corrections: Correction[]): Aligned {
  const fixedStarts = new Set(corrections.map((c) => c.start));
  const words: AlignedWord[] = whisper.map((w) => ({
    word: w.word,
    start: w.start,
    end: w.end,
    source: "whisper",
    prob: w.prob,
  }));
  // Mark the glossary-corrected words so the review page can highlight them.
  for (let i = 0; i < words.length; i++) {
    if (fixedStarts.has(words[i].start)) {
      const c = corrections.find((x) => x.start === words[i].start)!;
      for (let j = i; j < words.length && words[j].start < c.end; j++) {
        words[j].source = "glossary";
        words[j].heard = c.from;
      }
    }
  }

  const sentences: Sentence[] = [];
  let first = 0;
  let paragraph = 0;
  for (let i = 0; i < words.length; i++) {
    const last = i === words.length - 1;
    if (endsSentence(words[i].word) || last) {
      sentences.push(makeSentence(sentences.length, words, first, i, paragraph));
      // A long pause after a sentence usually means a new section.
      if (!last && words[i + 1].start - words[i].end > 1.2) paragraph++;
      first = i + 1;
    }
  }

  return {
    mode: "transcript",
    words,
    sentences,
    corrections,
    stats: {
      whisperWords: words.length,
      glossaryCorrections: corrections.length,
      lowConfidence: words.filter((w) => (w.prob ?? 1) < LOW_PROB).length,
      sentences: sentences.length,
    },
  };
}

/** Script words Whisper missed get times spread across the gap between their timed neighbours. */
function interpolateGaps(words: AlignedWord[]): void {
  let i = 0;
  while (i < words.length) {
    if (!Number.isNaN(words[i].start)) {
      i++;
      continue;
    }
    let j = i;
    while (j < words.length && Number.isNaN(words[j].start)) j++;
    const from = i > 0 ? words[i - 1].end : Math.max(0, (words[j]?.start ?? 0) - 0.3 * (j - i));
    const to = j < words.length ? words[j].start : from + 0.3 * (j - i);
    const run = words.slice(i, j);
    const chars = run.reduce((s, w) => s + w.word.length, 0);
    let t = from;
    for (const w of run) {
      const dur = (Math.max(0, to - from) * w.word.length) / chars;
      w.start = round(t);
      w.end = round(t + dur);
      t += dur;
    }
    i = j;
  }
}

function makeSentence(id: number, words: AlignedWord[], first: number, last: number, paragraph: number): Sentence {
  return {
    id,
    text: words.slice(first, last + 1).map((w) => w.word).join(" "),
    start: words[first].start,
    end: words[last].end,
    firstWord: first,
    lastWord: last,
    paragraph,
  };
}

const fmt = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
