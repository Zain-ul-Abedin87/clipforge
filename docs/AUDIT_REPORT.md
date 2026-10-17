# ClipForge — Mukammal Audit Report

*Code ki halat: 2026-10-16, branch `feature/general-web-crawler` (commit nahi hua). Is report ke saare numbers code se liye gaye hain.*

---

## 1. Tool kya hai (aik line mein)

Aap voiceover aur/ya script dete hain → ClipForge 1920×1080 faceless YouTube video banata hai: scenes, footage, cards, captions, sound, aur publish ke liye description/chapters. Sab kuch aap ke computer par chalta hai; Claude sirf kuch faislon ke liye (agar key ho).

**Do UI:**
| UI | Pata | Kis ke liye |
|---|---|---|
| Simple "Create" page | `http://localhost:4173/` | Script/voiceover daalo, channel chuno, Go |
| Classic editor | `http://localhost:4173/index.html` | Har step, scenes review, swap, QA, model vault, product research |

Shuru: `npm run serve`. CLI: `npx tsx src/cli.ts <command> -p <project>`.

---

## 2. Poora flow — aik nazar mein

```
Script / Voiceover
   │
   ├─ Step 0  TTS (sirf Mode B)      script → awaaz (computer voice / ElevenLabs / OpenAI / Piper)
   ├─ Step 1  Transcribe             awaaz → har lafz ka time (Whisper)
   ├─ Step 2  Align                  script ↔ awaaz jodna, farq dhoondna
   ├─ Step 3  Plan                   6–12 s scenes, type (product/stock/graphic), sections (#5..#1)
   │            └─ (Plan approval — classic UI mein, optional)
   ├─ Step 4  Assets                 har scene ki footage (own → model vault → press kit → card)
   │            └─ Model vault harvest (YouTube) agar product ki vault na ho
   ├─ Step 5  Timeline               2–3 s cuts, cards, lower thirds, SFX, logo, captions
   │            └─ (Scene review — "Review scenes before render" ON ho to)
   ├─ Step 6  Render                 har scene alag segment (cache), phir jod kar MP4
   └─ Step 7  QA                     checks + description/chapters/pinned comment → Approve
```

Har step ka output `workspace/<project>/` mein save hota hai. Dobara chalane par jo input nahi badla wo step "cached" ho kar skip hota hai (`--force` se dobara).

---

## 3. Input modes (aap kya dete hain)

| Aap ne diya | Mode | Text kahan se | Timing kahan se |
|---|---|---|---|
| Sirf voiceover | **A** | Whisper transcript (glossary se theek) | Voiceover |
| Sirf script | **B** | Aap ki script | TTS se bani awaaz |
| Script + voiceover | **C** | Aap ki script | Aap ka voiceover |

### Mode B — TTS
- `.env` mein `TTS_PROVIDER` **khaali** = Windows ki apni awaaz (robotic, draft ke liye). Speed: `WINDOWS_TTS_RATE` (-10..10, default 1).
- `elevenlabs` (key + voice ID), `openai` (key, default voice `alloy`, model `gpt-4o-mini-tts`), `piper` (exe + .onnx file).
- Lambi script tukron mein jati hai: ElevenLabs 2400, OpenAI 3800, Piper/Windows 20000 characters, phir FFmpeg se jodi jati hai.
- **Glossary pronunciation:** `inputs/glossary.txt` mein `Cat DG671 = Cat D G six seventy one` likhein → sirf TTS ko ye jata hai; **script kabhi nahi badalti**. Jo awaaz ko bheja gaya wo `tts_payload.txt` mein.
- Key ghalat ho (401/403) → saaf error. 429/500 par 2 dafa retry.

### Mode C — Script vs awaaz ke farq
- Script ke lafz awaaz ke lafzon se jode jate hain (banded Needleman-Wunsch alignment).
- Har mismatch run aik "discrepancy" banta hai: **omission** (script mein hai, bola nahi), **addition** (bola, script mein nahi), **substitution** (dono alag).
- **Significant** tab jab: number badla (999 vs 899), negation badla (not/never/don't…), ya model variant badla (pro, max, plus, mini, ultra, gen, mk, ii/iii…, ya p365/s24 jaise codes). "Gen 3" vs "Gen 5" → number + model_variant.
- Aap choose karte hain: `keep_audio` (captions mein jo bola), `correct_transcript` (Whisper ne ghalat suna, script sahi; ad-libs hatao), `modify_script` (script.txt ko awaaz jaisa badlo, backup `script.before-modify.*.txt`).
- Unresolved significant farq → QA **fail** (approve nahi hoga).

---

## 4. Step-by-step: har step kaise kaam karta hai

### Step 1 — Transcribe
- Whisper (`WHISPER_MODEL`, default `large-v3-turbo`, GPU `cuda`) har lafz ka start/end time deta hai → `words.json`.
- Glossary ke naam Whisper ko hint ke taur par jate hain (max ~600 characters).

### Step 2 — Align
- Glossary fix: "Moss Berg 500" → "Mossberg 500". Model number match hona zaroori (Glock 17 kabhi Glock 19 nahi banta). Similarity 0.8+ (chhote naam 0.85+).
- Script mode mein spelling script ki, timing Whisper ki. Jo lafz suna nahi gaya uska time andaze se (interpolate).
- Output: `aligned.json`, `discrepancies.json` (Mode C).

### Step 3 — Plan (scenes)
- Scene lambai video type se: e.g. general 6–12 s, documentary 6–14 s (avg 9), explainer/breakdown/tech 5–10 s (avg 7).
- **Listicle detection** (hard-coded regex): jumla "Number 5…", "#3", "coming in at number 2", "our number 1…" se shuru ho → naya section. Ranks 1–25, sirf lagatar chain (5,4,3,2,1) maani jati hai. Outro: "that wraps up", "thanks for watching", "see you in the next"…
- Claude (`LLM_MODEL`, default `claude-opus-5-5`) ya heuristic har scene ka type chunta hai: `stock`, `product`, `graphic` (title card, spec card, price badge, pros/cons), `image`.
- **Segment routing:** `specific_product` (kisi naam wale product ki baat) vs `generic_hook` (stats, intro, advice).
- "auto" channel: Haiku title+script parh kar niche banata hai (`<project>/niche.json`): category, shot length (1.8–3 s), search hints, blocked words.

### Step 4 — Assets (footage) — **sab se ahem**
Ab ki policy (default): **sirf asli exact-model footage**.

| Tarteeb | Source | Kab |
|---|---|---|
| 1 | Aap ki uploads (`channels/<ch>/footage/`) | Hamesha pehle |
| 2 | **Model vault** (`workspace/models/<brand>_<model>/`) | Scene us product ke baare mein ho, ya qareeb ka product |
| 3 | Press kit / official photos (`channels/<ch>/presskit/`) | Vault na ho |
| 4 | Text card + note | Kuch na mile |

- Pexels, Pixabay, Unsplash, Wikimedia, Archive.org, Storyblocks, CC/web crawl: **band** (`GENERIC_STOCK=on` se wapas).
- Vault na ho to assets step khud harvest karta hai (`AUTO_HARVEST=off` se band). Detail: Section 5.
- Scene ko vault se clip kaise milti hai (`vaultAsset`):
  1. Scene ka product (scene ka `product_name`, ya jis section mein hai). Na ho to sab se qareeb wale product scene ki vault.
  2. Har clip ka rank: kam use hui pehle (×10 weight) → scene ke text mein clip ka feature ("deck") ho to bonus (−5) → video, photo se pehle → zyada CLIP score.
  3. Pichla scene still ho aur ye bhi still banta → sirf video clip ("mustMove", slideshow se bachne ke liye).
  4. Har vault clip review page mein swap option bhi ban jati hai (max 40).
- Vault clips `product_pool.json` mein bhi likhi jati hain → timeline har scene ko kai clips se 2–3 s cuts mein kaat-ti hai.
- Har asset ka licence `license_log.csv` aur `licenses.json` mein.

### Step 5 — Timeline
- FPS 30, 1920×1080. Frame-exact boundaries (drift nahi).
- **Pacing** (niche mein on ho): target shot 2.8 s default (tech 2.1, guns 2.5), min 1.4, max 4, pehle 30 s thoda tez. Cuts lafzon ke start par lagte hain. Same clip ka wohi hissa 30 s (`REUSE_GAP_SEC`) se pehle dobara nahi.
- Cards (Remotion), lower thirds, rank badges, flash transitions, whoosh/pop SFX (-14 dB), logo, captions (channel setting).
- **Music default OFF.** `style.json` mein `music.enabled: true` aur niche ne mana na kiya ho tab hi.
- Price cards ki qeemat script se (`facts.json`) — QA match check karta hai.

### Step 6 — Render
- Har scene alag segment: NVENC (GPU, cq 22, max 10 Mbps); fail ho to 2 dafa retry phir x264.
- **Cache:** har scene ka SHA-256 hash = awaaz ka hissa + footage file (path, size, time) + captions + overlays + transition + motion + logo. Hash same → purana segment reuse. `workspace/<p>/cache/segments/`.
- Aik scene badla → sirf wo render, baqi jod diye (FFmpeg concat, har file ki exact duration, drift nahi).
- `render --scene 12` ya UI "⟳ Re-render scene".
- Audio: voice + SFX (+ music agar on, voice par duck), loudness -14 LUFS, true peak -1.5. AAC 192k.
- RAM 4.5 GB se kam free → 1 segment aik waqt mein.

### Step 7 — QA
Fail = approve nahi ho sakta. Warn = dekh lein.

| Check | Fail / Warn kab |
|---|---|
| Resolution / codec / fps | 1920×1080, H.264 + AAC, 30 fps na ho → fail |
| A/V sync, length | 0.1 s / 0.15 s se zyada farq → fail |
| Black frames | 0.4 s+ → fail |
| Frozen video clip | 3 s+ → warn |
| Silent gaps | 2.5 s+ warn, **5 s+ fail** |
| Loudness | -14 ± 2 LUFS se bahar → warn |
| Media files | missing / khaali / ffprobe na khole → fail |
| Clip reuse | aik clip 4 se zyada scenes (tech-amazon: 3) → fail |
| Distinct footage | 60% se kam warn, 40% se kam fail |
| Repeated segments | same source ka same hissa dobara → fail |
| Product section mein doosre product ki clip | fail |
| Exact model | conflict → fail; unverified → warn (strict niche mein fail) |
| Licence ledger | external asset ka record na ho → fail |
| Mode C farq | unresolved significant → fail |
| Exact-model YouTube clips | use hui hon → **warn (rights)** |
| Web-crawled / CC uploaders | warn |
| Still images ka hissa | niche ke hisaab se (e.g. 50% warn, 65% fail) |
| Picture vs narration (Claude dekhta hai) | ghalat product → fail |
| Price card vs script | mismatch → fail |

- `qa --preflight`: video ke baghair files/reuse/model/licence/farq check.
- Approve ke baad video dobara render ho → approval khud cancel.
- Output: `report.md`, `qa_report.json`, `publish/` (description, chapters, pinned comment, title, thumbnails).

---

## 5. YouTube se clips kaise aati hain (Model vault)

Code: `src/lib/assets/ytExtractor.ts` (faisle) + `python/yt_extract.py` (YouTube se baat, `yt-dlp`). Koi YouTube API key nahi.

### 5.1 Search
4 queries, har aik ke top 10 results (sirf list, download nahi):
```
"<brand> <model>" walkaround
"<brand> <model>" review
"<brand> <model>" demo
"<brand> <model>" official
```

### 5.2 Video chunne ke rules (hard-coded)
| Rule | Value |
|---|---|
| Title mein exact model | zaroori; space/dash chalta hai ("HRX 217", "Z-930M") |
| Trim suffix | model digit par khatam ho to 1–3 letters chalte hain ("HRX217HZA") — `HARVEST_ALLOW_TRIMS=off` se band |
| Doosra model title mein | reject ("HRX216 vs HRX217", "Z930M vs Z960M") — size jaise `21"` ko model nahi maana jata |
| Generation alag | reject ("Gen 5" jab "Gen 3" chahiye) |
| Lambai | 45 s se kam ya 25 min se zyada → reject |
| Tarteeb | title mein walkaround/official/demo +2, brand ka apna channel +1 |
| Max videos | 6 (`HARVEST_MAX_VIDEOS`) |

### 5.3 Video ka kaunsa hissa
- 4 windows × 20 s (`HARVEST_WINDOWS`, `HARVEST_WINDOW_SECONDS`).
- Pehle 10 s (intro) aur aakhri 8% (outro) chhor diye.
- Uploader ke chapters mein aap ka feature ("deck") ho → wo hissa pehle.
- Baqi barabar faasle par; takrayein to aage/peechhe sarka diye jate hain.

### 5.4 Download
- `yt-dlp` sirf wo 20 s, **bina audio**, max 1080p. FFmpeg se H.264 mp4.
- YouTube 403 de → naya link le kar retry, phir chhoti full-file fallback. Har window 3 min timeout.
- Proxy (`YTDLP_PROXY`), cookies (`YTDLP_COOKIES_FILE` / `YTDLP_COOKIES_FROM_BROWSER`), requests ke beech wait — pehle wale web_crawl code se.
- Vertical video reject.

### 5.5 Shots aur talking-head filter
1. FFmpeg `select='gt(scene,0.3)'` → camera cuts. Cut ke dono taraf 0.1 s trim.
2. 1.5 s se chhota shot hata do; 6 s se lamba → 5 s tukde.
3. Har shot ki beech wali frame (full quality JPG).
4. CLIP (`clip-ViT-B-32`, local) frame ko in texts se milata hai:
   - **Positive:** `"<brand> <model> <category> machine closeup action outdoors"` (category default "lawn mower", ya niche ki product category, ya `HARVEST_CATEGORY`)
   - **Negatives (sab se zyada wala ginta hai):**
     1. "a person talking to the camera face portrait man speaking in studio"
     2. "a man standing in a shop talking to the camera next to a <category>"
     3. "close up of a person face talking"
     4. "a cartoon logo intro animation"
     5. "a title card with text on a plain background"
5. **Faisla:**
   - worst negative ≥ 0.34, ya positive − worst negative < 0.005 → **reject** (talking head ya logo/title)
   - positive < 0.20 → **reject** (machine nahi)
   - warna **keep**
6. Feature tag: har feature ka prompt bhi score hota hai ("<brand> <model> <category> deck close up"); sab se achha wala feature likha jata hai.
7. Keep: `clips/<id>.mp4` (crf 18, bina audio) + source HD (720p+) ho to `frames/<id>.jpg`. Reject: frame delete. Download ke tukde aakhir mein delete.

> Calibration (asli frames par): dealer mower ke saath baat kar raha tha → positive se 0.02–0.11 neeche, reject. Cartoon logo → reject. Walkaround B-roll → 0.02–0.04 upar, keep. **Margin patla hai — vault aik dafa dekh lein.** Sakht karna ho to `HARVEST_MARGIN` barhayein aur `--rescore` chalayein.

### 5.6 Vault aur manifest
```
workspace/models/scag_turf-tiger-ii/
  clips/   *.mp4
  frames/  *.jpg
  manifest.json   brand, model, category, features,
                  items[ video URL + &t=, channel, title, start/end, CLIP +/- scores, feature, size ],
                  processed{video: windows},  rejectedVideos[ title + wajah ],  stats
```
- Dobara chalane par jo windows ho chuki, skip. Fail hui windows agli dafa dobara.
- `--rescore`: maujooda clips naye filter se dobara check, bina download.
- Project mein product → vault: product ke naam mein vault ka exact model ho; brand bhi match kare to wo pehle; lamba model naam pehle ("Turf Tiger II" > "Turf Tiger").

### 5.7 Commands / UI
```bash
npx tsx src/cli.ts harvest-model --brand "Scag" --model "Turf Tiger II" --features "deck,engine,blades"
```
Options: `--category`, `--exclude "Z960M,Z950M"`, `--max-videos`, `--windows`, `--force`, `--rescore`.
Classic UI: **Model vault** card, ya Product research panel mein har product par "Harvest clips".

---

## 6. Products aur exact model

- Har product ka record `product_research.json`: manufacturer, model, variant, generation, Amazon URL + ASIN, affiliate link (alag), spec pages, status.
- Brand: pehla lafz, siwaye in multi-word brands ke: John Deere, Cub Cadet, Bad Boy, Briggs & Stratton, Black+Decker, Black & Decker, Smith & Wesson, Sig Sauer, Rock Island Armory, Spartan Mowers, Big Dog, Hustler Turf. Ghalat ho to UI mein theek karein.
- **Affiliate link kabhi footage search mein nahi jata** (URL/ASIN wali query error deti hai).
- Model match verdicts: `match` / `conflict` (doosri generation, variant, model number, brand) / `needs_review` (variant/generation title mein nahi) / `no_match`.
- UI mein "✓ Exact model" / "✕ Wrong model" → `model_verifications.json` (file path se jura, re-run ke baad bhi rehta hai).

---

## 7. Licence ledger (`licenses.json`)
Har scene aik record: category (`own`, `presskit`, `official`, `review`, `stock`, `wikimedia`, `archive`, `unsplash`, `web`, `generated`), licence class (public domain, CC0, CC BY, CC BY-SA, stock, editorial, own, unknown), attribution chahiye ya nahi, URL, author, kitne scenes mein use, pehli dafa kab.
- YouTube vault clip: channel naam mein brand ho → `official`, warna `review`. Licence text: "standard YouTube licence – editorial use, check rights".
- Clip reuse ka penalty: 1st use 0, phir 0.04, 0.16, 0.28… (barhta jata hai).

---

## 8. Hard-coded cheezein (aik jagah)

### Code mein fixed (badalne ke liye code edit)
| Cheez | Value | File |
|---|---|---|
| Resolution / FPS | 1920×1080, 30 | `render.ts`, `timeline.ts` |
| Fade | 0.25 s | `render.ts` |
| Loudness | -14 LUFS, TP -1.5 | `render.ts` |
| NVENC quality | cq 22, max 10 Mbps, GOP 60 | `render.ts` |
| Listicle header / outro regex | "number N", "#N", "thanks for watching"… | `planner/structure.ts` |
| YouTube query words | walkaround, review, demo, official | `ytExtractor.ts` |
| Video lambai | 45 s – 25 min | `ytExtractor.ts` |
| Intro skip / outro skip | 10 s / aakhri 8% | `ytExtractor.ts` |
| Scene cut threshold | 0.3 | `ytExtractor.ts` |
| Shot min / max / slice | 1.5 s / 6 s / 5 s | `ytExtractor.ts` |
| CLIP prompts (1 positive, 5 negative) | Section 5.5 | `ytExtractor.ts` |
| Still sirf 720p+ source se | 720 | `ytExtractor.ts` |
| Negation / variant word lists | Section 3 | `lib/align.ts`, `productResearch.ts` |
| Multi-word brands | Section 6 | `productResearch.ts` |
| QA thresholds | Section 4, Step 7 | `qa.ts`, `qaGate.ts` |
| Mode C ad-lib alignment band | 250 tokens min | `lib/align.ts` |

### `.env` se badalne wale (aham)
| Setting | Default | Kaam |
|---|---|---|
| `GENERIC_STOCK` | off | Stock sites wapas |
| `AUTO_HARVEST` | on | Vault na ho to khud harvest |
| `HARVEST_CATEGORY` | niche ya "lawn mower" | CLIP prompt ka machine lafz |
| `HARVEST_MAX_VIDEOS` / `HARVEST_WINDOWS` / `HARVEST_WINDOW_SECONDS` | 6 / 4 / 20 | Kitna download |
| `HARVEST_MARGIN` / `HARVEST_MIN_POSITIVE` / `HARVEST_MAX_NEGATIVE` | 0.005 / 0.20 / 0.34 | Talking-head filter |
| `HARVEST_ALLOW_TRIMS` | on | HRX217HZA = HRX217 |
| `TTS_PROVIDER` | (khaali = Windows) | Awaaz |
| `LLM_MODEL` | claude-opus-5-5 | Scene labels, agents |
| `WHISPER_MODEL` | large-v3-turbo | Transcribe |
| `VIDEO_ENCODER` | h264_nvenc | GPU / x264 |
| `RENDER_CONCURRENCY` | auto (RAM) | Parallel segments |
| `REUSE_GAP_SEC` | 30 | Same clip hissa dobara kab |
| `PRODUCT_PARALLAX` | on | Product photo ka 2.5D effect |

### Niche file (`niches/*.json` ya project ka `niche.json`) se
Scene lambai, listicle on/off, cards ka hissa, product sources, stock hints, blocked words, pacing (shot length), QA still limits, exact-model rules (`productMatch`), music on/off.

### Channel (`channels/<ch>/style.json`) se
Rang, fonts, captions, logo, music (default off), motion graphics/SFX, cards ka set, shot length.

---

## 9. Files — kahan kya milega

| File | Kya |
|---|---|
| `workspace/<p>/project.json` | Settings, mode, discrepancy choices |
| `words.json` / `aligned.json` | Lafz + time |
| `discrepancies.json` | Mode C farq |
| `scenes.json` / `sections.json` | Plan |
| `assets.json` / `candidates.json` | Footage + swap options |
| `product_research.json` / `product_pool.json` | Products / pacing shots |
| `licenses.json` / `license_log.csv` | Licence |
| `timeline.json` | Final edit (hand se bhi badal sakte hain) |
| `cache/segments/` | Render cache |
| `render_report.json`, `qa_report.json`, `report.md`, `publish/` | Nateeje |
| `output/<p>.mp4` | Final video |
| `workspace/models/<brand>_<model>/` | Model vault (sab projects ke liye) |

---

## 10. Kamzoriyan aur khatre (imaandari se)

1. **Copyright:** vault clips doosre channels ki hain. Content ID claim / strike mumkin. QA warn karta hai; ijazat lena behtar.
2. **CLIP filter heuristic hai:** margin patla (~0.02). Vault thumbnails dekh lein; zaroorat ho to `HARVEST_MARGIN` barha kar `--rescore`.
3. **Face detection nahi:** is OpenCV build mein Haar face detector nahi, is liye sirf CLIP par bharosa.
4. **Slow internet:** windows 3 min mein na aayein to skip (agli dafa retry). Pehli dafa harvest har model par kai minute.
5. **Title par bharosa:** agar video ka title sahi model bataye lekin video mein doosra model ho, filter nahi pakrega (CLIP sirf "mower hai ya nahi" dekhta hai, model nahi).
6. **Brand split:** list mein na ho to multi-word brand ghalat tootega ("Positec Cat" wagera) — Product research panel mein theek karein.
7. **Product na ho to:** generic B-roll scenes bhi qareeb wale product ki clips lete hain (stock band hai), is liye ek product ki clips zyada dikh sakti hain.
8. **Windows awaaz** robotic hai — upload ke liye ElevenLabs/OpenAI.
9. **Simple UI (`/`)** mein vault, discrepancies, product research ke panels nahi — wo classic UI (`/index.html`) mein hain.
10. **Pehli dafa:** render cache ki jagah badli, align ka cache key badla → purane projects mein aik dafa poora render/align.
11. **Commit nahi hua** — sab tabdeeliyan abhi working tree mein hain.

---

## 11. Tests
`npm test` → 45 tests (TTS, glossary, discrepancies, niche/music, product match, ledger, scene hash, QA gate, asli FFmpeg incremental render, stock policy, YouTube title/window/shot rules, vault). Sab pass. Asli harvest Honda HRX217 aur Scag Turf Tiger II par chalaya gaya aur frames aankh se check kiye gaye.
