# Faceless listicle channel study → ClipForge target spec
Date: 2026-10-13. Data: yt-dlp flat lists (15 latest uploads × 13 channels, `lists/summary.md`), 4 videos downloaded at 360p for style analysis only (`vids/`, can be deleted).

## 1. Channel survey (latest 15 uploads)
| Channel | Niche | Median length | Median views | Top recent |
|---|---|---|---|---|
| TechNexer | tech/vehicles/gadgets | 18 min | 2.5k | 15 Electric Trikes (62k) |
| -TechGear | vehicles/gadgets | 17 min | 7.7k | Genius Truck Innovation (182k) |
| Techfusion98 | Amazon gadgets | 29 min (some 70–144 min) | 7.4k | 40 "Illegal" Gadgets Under $30 (48k) |
| KRAFTY.KRAFT01 | tools/satisfying compilations | 40–60 min | 64k | 175 Satisfying Machines (804k) |
| The_TechTrends | AI/smart gadgets | 17 min | 8.3k | Top 10 New Technologies (86k) |
| TechTVus | Amazon tools/car gadgets | 41–61 min | 2.3k | 50 Ingenious Tools on Amazon (519k) |
| HardYardCo | mowers | 16 min | (hidden) | – |
| AllenWaldrep | golf carts | 12 min | (hidden) | – |
| trending.machine | vehicles/houses/inventions | 31 min | 195k | 50 Houses… (773k) |
| survivalgearofficial | guns/Amazon weapons | 13 min | 22k | Cold Steel Weapons (155k), $250 Truck Gun (142k) |
| GunsYouCantLiveWithout | guns | 10 min | 10k | 10 Cold Steel Weapons Stockpiling (186k) |
| ShotgunAddicts | guns | 18 min | 10k | 7 Revolvers ZERO % Failure (23k) |
| AllAboutSurvival | guns/survival | 12 min | 4k | $250 Shotgun Nobody Wants (64k) |

Upload dates aren't returned by --flat-playlist; all are recent (latest-15).

**Title patterns:** 
- Number + superlative + object + hook: "15 Incredible Electric Trikes You Must See to Believe!", "Top 10 Best X for 2027".
- Amazon/price angle: "on Amazon", "Under $30", "$250 truck gun", "#11 Sold Out Twice", "(With Prices)".
- Fear/urgency (guns): "NEVER Buy … From These 7 Brands — Gunsmiths Say…", "Selling Out FAST", "Before They Get Banned", "Prices Are Crashing", "Skip these 5 — stockpile these 5".
- Future year ("2027") everywhere; CAPS on 1–3 words; templated titles reused across channels (HardYardCo/AllenWaldrep share the same templates → same operator).

**Lengths:** listicles 10–20 min (your target 15–20 is right). Compilation channels (KRAFTY, TechTVus, trending.machine) go 30–60 min with 50–250 items.
**Top performers:** Cold Steel / "Amazon weapons" / cheap truck gun (guns); tool & vehicle compilations (tech). Outliers are 10–50× channel median.

## 2. Deep dive (4 videos)
| Video | Niche | Length | Shots | Avg shot | Median shot | Cuts/min | Shots <2 s | Shots >6 s |
|---|---|---|---|---|---|---|---|---|
| TechNexer – 15 Electric Trikes | tech | 16.9 m | 415 | 2.4 s | 1.7 s | 24.6 (31 in first 5 min) | 59 % | 6.5 % |
| The_TechTrends – Top 10 Smart Wallets | tech | 10.2 m | 259 | 2.4 s | 1.6 s | 25.4 | 61 % | 5.8 % |
| survivalgearofficial – Cold Steel Weapons | guns | 13.9 m | 302 | 2.8 s | 2.1 s | 21.7 | 46 % | 10.6 % |
| ShotgunAddicts – 7 Revolvers | guns | 13.6 m | 278 | 2.9 s | 2.5 s | 20.5 | 36 % | 5.4 % |
(PySceneDetect ContentDetector thr 27. Contact sheets = 1 frame/5 s, first 5 min.)

**Whisper (faster-whisper tiny, 2 min each):** TechNexer 133 wpm, 2.1 cuts per sentence, ~4.8 words per shot. ShotgunAddicts 190 wpm, 1.1 cuts per sentence, ~8.6 words per shot. Rule: **a new shot every 5–8 spoken words**, and almost always at least one cut per sentence.

**Audio:** integrated loudness −13.6 to −21.6 LUFS, LRA only 3–4 LU, and practically no gaps below −50 dB across 10 min → **a continuous music bed under the voice in all 4** (guns quieter/darker; tech louder, upbeat).

### What's on screen
**Tech (TechNexer, The_TechTrends)**
- Source mix: ~90 % official manufacturer promo/Kickstarter footage (lifestyle shots, studio packshots on white/grey), ~10 % reviewer/hands-on clips. No stock B-roll for products, no AI renders seen.
- Product intro: small animated **name pill lower-left** with channel logo ("TN | TERRAGLIDE M2", "SHUFFLE WALLET 2.0"), plus a small round rank badge ("02") in the corner. No full-screen number card. No price card seen.
- Spec/feature callouts: short lower-left captions in caps, sometimes with a highlight ("CARRY UP TO SEVEN ESSENTIAL CARDS", "APPLE FIND MY AND GOOGLE FIND HUB", "RFID-BLOCKING PROTECTION"), roughly one per 20–40 s. These are key-feature lines, not word-by-word captions.
- Persistent **channel logo watermark top-right**, a logo-sting transition (HUD ring) after the ~30 s cold-open montage, and a "SUBSCRIBE" pop-up at ~0:25.
- Mostly hard cuts on motion. Light punch-ins on stills, no Ken Burns-heavy slides. No burned captions.
- Structure: a 20–30 s fast hook montage of the best shots → logo sting → items in order. Each item runs 50–70 s, about 20–30 shots.

**Guns/survival (survivalgearofficial, ShotgunAddicts)**
- Source mix: ~75–85 % YouTube reviewer range footage (shooting, handling, close-ups of the action/cylinder, POV), ~10 % official brand promo (e.g. Cold Steel demo videos with the brand backdrop), ~5–10 % graphics. Occasional b/w historical photo.
- Product intro (ShotgunAddicts): a **dark textured full-screen card with a product photo in a rounded box, white name bar with type-on reveal ("SMITH & WESSON MODEL 686"), and the rank number "07" below**. Also a **full-screen price card** ("$1000" in white on dark) before or after.
- survivalgearofficial: a small lower-left **name tag** ("COLD STEEL" + model) over footage, faint channel watermark, darker grading.
- Cuts are slightly longer (2–3 s) and favour action moments: firing, recoil, cutting tests, reloads.
- No burned captions in either. Hard cuts, plus quick black flashes between items.

**Common:** no presenter, no burned word-captions, hard cuts dominate, a music bed is always present, there's an item-intro graphic per entry, and the same product is shown from 15–30 different shots.

## 3. Target editing spec for ClipForge
**Pacing**
- Average shot **2.4 s (tech) / 2.8 s (guns)**, median 1.7 / 2.3 s. Hard limit 6 s, except for the name card (≤3 s) and price card (≤1.5 s).
- About 1 cut per 5–8 words. Cut on Whisper word boundaries, not on scene boundaries. The first 30 s runs ~30 cuts/min.

**Per-product sequence template (≈50–70 s per item in a 15–20 min video)**
1. 0–0.3 s: whoosh + flash/black dip.
2. **Item card** (guns style): dark textured background, official product photo in a rounded box, name bar with type-on reveal, rank "07" below; 2–3 s. Tech style: hero shot with the name pill lower-left plus a rank circle.
3. Optional **price card** "$1,000" (1–1.5 s) when the script mentions a price.
4. 3–5 official/hero shots (1.5–2 s each, slight 105→110 % punch-in on stills).
5. Body: 15–25 shots at 2–3 s. Tech ≈ promo lifestyle + feature close-ups. Guns ≈ reviewer range clips, handling, close-ups, test footage.
6. 1–3 **feature callouts** lower-left (caps, ≤6 words, accent highlight), timed to the spec sentence.
7. The rank badge and channel watermark stay on screen throughout.

**Global structure:** 20–30 s hook montage (best shots of the top 3 items, fastest cuts) → logo sting + whoosh → items countdown → subscribe pop at ~0:25 and mid-video → short outro (~10 s end-screen space).

**Graphic elements to build:** item card (guns) and name pill (tech) templates, price card, feature callout, rank circle, corner logo watermark, logo sting, subscribe pop. Remove word-by-word captions by default.

**Source-mix targets**
| Source | Tech | Guns |
|---|---|---|
| Official promo/press video | 70–90 % | 10–15 % |
| YouTube reviewer clips | 10–20 % | 70–80 % |
| Official/Amazon stills (cards, punch-ins) | 3–5 % | 5 % |
| Generic stock B-roll | <5 % (hook/transitions only) | <5 % |
| Graphics (cards) | ~5 % | ~5–8 % |

**Audio:** music bed −18 to −22 dB under the voice with sidechain ducking, final mix ≈ −14 LUFS. Whoosh on item transitions only, not every cut.

## 4. Gap list vs current ClipForge
| Area | ClipForge now | Target | Gap |
|---|---|---|---|
| Shot length | ~4 s avg | 2.4–2.8 s, median <2 s | Needs ~1.6× more shots and multi-shot per sentence |
| Shots per product | ~1 clip per scene | 15–30 shots of the *same* product | Must harvest many sub-clips per source video (scene-split the downloaded video, pick the best N) |
| Mismatch | 9/35 scenes wrong | ~0 (every shot shows the named product) | Product-locked sourcing: search by exact product name, CLIP/vision filter against an official photo |
| Source mix | Stock-heavy (Pixabay/Storyblocks fallback) | Promo/reviewer-heavy | Stock should be last resort; official YouTube channel + reviewer search first |
| Captions | Burned word captions | None, only feature callouts | Turn off by default, add callout generator (LLM picks spec lines) |
| Item intro | Rank badge + lower third | Full item card (photo + name type-on + rank) / name pill | New template |
| Price card | none | yes | New template |
| Transitions | Flash on many cuts | Hard cuts; flash/whoosh only between items | Reduce |
| SFX | whoosh/pop frequent | Sparse | Reduce |
| Music | none by default | Always, ducked | Ship a music library + ducking |
| Hook/intro | none | 20–30 s montage + logo sting | New |
| Branding | none | Corner watermark, subscribe pop | New |
| Quality | 480p web clips (now fixed to 1080p) | 1080p | Re-render |

## 5. Prioritized implementation steps
1. **Product-locked footage harvesting (biggest win).** For each product from the script: search YouTube for "<exact name>" (official channel + top reviewers), download 1080p sections, scene-split each with PySceneDetect, score the sub-shots with CLIP against the official product photo, and keep the top 20–30 per product. This fixes the mismatches and gives the shot volume.
2. **Pacing engine.** Cut on Whisper word timestamps every 5–8 words (2–3 s), never the same sub-shot twice, and prefer action/motion shots (frame-diff score).
3. **Music bed + ducking** (FFmpeg sidechaincompress), with niche presets: dark/tense for guns, upbeat for tech. Normalize to −14 LUFS.
4. **Item card + price card + feature callout templates** (two style presets: "guns-card" and "tech-pill"). Captions off by default.
5. **Hook montage + logo sting + watermark + subscribe pop.**
6. Cut back flash/whoosh to item boundaries only.
7. Official stills (Amazon/manufacturer) used only on cards and as short punch-ins.
8. QA: per-shot CLIP match against the product photo, plus the shot-length histogram vs target.

**Risk:** guns channels lean heavily on other creators' footage. Keep sub-clips short (≤3 s), mix sources, and keep the uploader/link list (already in report.md of runs) to answer claims.

Contact sheets: `contact_CgoQVkZ0rXA.png` (TechNexer), `contact_voGvAw0f8v8.png` (The_TechTrends), `contact_muQyFTO7MZA.png` (survivalgearofficial), `contact_LQJLxKAra9s.png` (ShotgunAddicts). Raw: `lists/`, `vids/*.scenes.json`.
