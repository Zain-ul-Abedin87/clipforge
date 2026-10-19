# Report: 7 sec clips aur ek hi clip baar baar repeat kyun hua

Branch: `feature/general-web-crawler`

## Short jawab

Do alag bugs thay, aur dono ek dusre ko bura bana rahe thay:

1. **7 sec ka clip:** `general`, `documentary`, `explainer`, `listicle`, `breakdown` aur `guns`
   niches mein `pacing` block hi nahi tha. Code mein pacing sirf tab chalti thi jab niche khud
   `"enabled": true` likhe. Is liye scene cut hi nahi hota tha, aur poora scene (5 se 12 sec) ek hi
   clip par chalta tha. Pacing ke liye `aligned.json` bhi zaroori tha, warna phir se cut nahi hota.
2. **Ek clip ka multi-time repeat:** jab pacing chalti bhi thi, to scene ka dusra cut apne hi clip
   ko use nahi kar sakta tha (rule: "same source back-to-back nahi"). Koi aur clip na mile to code
   "forced reuse" mein chala jata tha, jo **har baar `in = 0`** se clip shuru karta tha. Yani bilkul
   wahi frames dobara. Upar se renderer har video ko `-stream_loop -1` ke saath kholta hai, to jo
   cut file ki length se lamba ho, woh khamoshi se clip ko shuru se dobara chala deta hai.

## Har repeat ka source (code ke hawale ke saath)

| # | Kahan | Kya galat tha | Nateeja |
|---|-------|---------------|---------|
| 1 | `src/lib/pacing.ts` `pacingConfig` | `enabled: p.enabled === true`: bina pacing block wali niches mein pacing off thi | Poora scene ek clip (7 sec) |
| 2 | `src/commands/timeline.ts` | Pacing sirf tab chalti thi jab `aligned.json` mojood ho | Alignment fail hui to bhi 7 sec |
| 3 | `src/lib/pacing.ts` forced reuse | `in: a.in ?? 0` har dafa | Wahi pehle 2-3 sec dobara |
| 4 | `src/lib/pacing.ts` generic pool | Duration pata na ho to `?? 8` maan liya jata tha | Window file ke end se aage nikalti, renderer loop kar deta |
| 5 | `src/commands/assets.ts` web_cc | Clip `min(12, ceil(len + 0.5))` sec ka: 15 sec scene ko 12 sec clip | Last 3 sec loop |
| 6 | `python/web_crawler.py` cache | Purani (chhoti) cached clip length check kiye bina reuse hoti thi | Naye lambe scene par loop |
| 7 | `src/lib/qaGate.ts` | Sirf "ek clip 4 se zyada scenes mein" check tha | Same scene ke andar repeat QA mein pakra hi nahi jata tha |

## Kya fix kiya

- **Random 2 / 3 / 4 sec shots, max 4 sec.** Naya `randomPieces` / `randomCuts`. Har scene ko
  2, 3 ya 4 sec ke random tukron mein kaata jata hai. Har tukra 2 se 4 sec ke beech rehta hai, aur
  cut word ke start par snap hota hai, lekin sirf tab jab dono taraf ke tukre 2-4 sec mein rahein.
  Random seeded hai (scene ke start time se), is liye dobara render par same cuts aate hain aur
  render cache kharab nahi hota.
- Jin niches ka apna pacing block nahi tha, un mein ab pacing default **on** hai, random 2/3/4 ke
  saath. `guns_web`, `tech_web` aur `tech-amazon` apni channel-study pacing rakhti hain (unka max
  pehle hi 3-4 sec hai). Override: `SHOT_CHOICES=2,3,4` ya `SHOT_CHOICES=off`. Poori pacing band:
  `PACING=off`.
- `aligned.json` na ho to bhi pacing chalti hai (sirf word-snapping nahi hoti).
- Repeat se pehle scene ke **apne clip ka agla unused hissa** try hota hai.
- Agar phir bhi repeat zaroori ho: in-point pehle dikhaye gaye hisson se sab se door chuna jata
  hai, file ki length ke andar, aur mirror ya punch-in crop lagta hai.
- Unknown duration wale clips dusre scenes ko "generic" B-roll ke taur par nahi diye jate.
- web_cc clip ab poore scene + 1 sec (max 30) ki hoti hai. Cache sirf tab reuse hota hai jab clip
  kaafi lambi ho.
- QA gate mein 2 nayi checks: **"No clip moment shown twice"** (same file + same in-point + same
  variant = fail) aur **"Shot length (max 4 s)"** (warn).

## Crawler review (`web_crawl.py` / `web_crawler.py`)

**Crawler kya karta hai:** do raste hain.
- `web_crawler.py` (source `web_cc`): last resort. DuckDuckGo video/text search, phir yt-dlp sirf
  page metadata padhta hai. Clip sirf tab download hoti hai jab page khud CC BY / BY-SA / CC0 /
  public domain kahe (NC/ND reject). Download sirf ek chhota range hota hai, moviepy check karta
  hai, muted piece cut hota hai, aur licence JSON saath likha jata hai.
- `web_crawl.py` (source `web_crawl`): licence check **nahi** hota. YouTube + DDG se search,
  preview download, shot split, CLIP score, phir sirf chuna hua shot HD mein. Licence
  `unknown/web` likha jata hai aur QA copyright warning deta hai.

**Pehle se theek tha:** per-run crawl limit, Node se kill timeout, Python ka apna deadline,
temp cleanup, DDG rate-limit backoff, yt-dlp retries aur sleep intervals.

**Fix kiye:**
- robots.txt check nahi tha. Ab har host ka robots.txt ek baar padha jata hai (RFC 9309: 4xx
  matlab koi rule nahi, 5xx matlab disallow). Agar site tak pahunch hi na sakein to allow hota hai
  aur log line aati hai. Band karne ke liye: `WEBCC_ROBOTS=off`.
- Per-host rate limit nahi tha. Ab har host par probes ke beech kam se kam 1.5 sec ka gap hai
  (`WEBCC_HOST_DELAY`).
- `-word` (exclude) query mein ulta `word` search ban jata tha. Ab woh lafz hata diya jata hai.
- `search()` jab 15 hits par ruk jata tha to site-wise interleave skip ho jata tha. Ab interleave
  hota hai.
- Chhoti cached clip ka reuse (upar #6).

**Abhi bhi missing hai (is commit mein nahi):**
- `web_crawl.py` (licence-free wala) mein robots.txt / per-host delay nahi lagaya. Yeh YouTube
  ytsearch zyada use karta hai. Isko alag se dekhna chahiye, aur yeh copyright risk wala rasta hai.
- robots.txt ka asal asar (YouTube, archive.org, Wikimedia par kitne hits block honge) main yahan
  verify nahi kar saka. Sandbox ka proxy un sites ko block karta hai. Pehla real run ka log
  dekhein: `disallowed by robots.txt` lines. Agar footage bahut kam ho jaye to `WEBCC_ROBOTS=off`.
- web_cc ab lambi clip (scene + 1 sec) maangta hai. Iska matlab hai ke chhoti CC videos zyada
  reject hongi aur hit-rate thoda gir sakta hai.
- Renderer ka `-stream_loop -1` abhi bhi hai. Pacing ab windows ko file ke andar rakhti hai, lekin
  agar kisi asset ki `duration` metadata ghalat ho to loop phir bhi ho sakta hai. Behtar fix:
  loop ki jagah last frame hold (`tpad`) ya render se pehle `ffprobe` check.
- Network wale hisson (DDG, yt-dlp download) ke integration tests nahi hain. Tests sirf pure logic
  cover karte hain.

## Tests

- `tests/pacing.test.ts` (13 tests): 2-4 sec range, random variety, deterministic cuts, 7 sec
  scene kabhi ek shot nahi, koi moment do baar nahi, file ke end se aage window nahi, QA checks,
  web clip length.
- `tests/test_web_crawler.py` (12 tests): sanitize, licence, interleave, robots.txt rules, per-host
  delay, cache length check. Chalayein: `npm run test:py`.
- Poora suite: `npm test`: 120 pass, 0 fail, 3 skipped (yeh 3 pehle se skip thay).

## Aapko kya karna hai

Purana project dobara chalayein. Timeline step khud dobara banega, kyun ke pacing ka cache key
badal gaya hai. Phir `[pacing]` log line mein `avg` shot length dekhein (2-4 sec ke beech honi
chahiye), aur QA mein "No clip moment shown twice" pass hona chahiye.
