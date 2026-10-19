# Audit: video-1019-1843 (scenes repeat, wrong footage)

Code nahi badla gaya. Ye sirf report hai: har masle ka saboot (log line) aur code me asal wajah.

## Khulasa

Is video me **431 shots me se 307 "forced reuse"** the, yani teen chothai shots ek hi clip ko
dobara chala rahe the. **10 me se 7 chapters me us product ki 0% apni footage** thi.

Repeat hona sirf ek natija hai. Asal masla ek zanjeer hai, aur pehli kadi hi tooti hui thi:

```
Whisper ne naam galat sune -> product ke naam / brand-model galat bane -> YouTube search me 0 match
-> vault khaali -> pacing ke paas footage nahi -> pas wale product ki 1 clip 30 scene tak chalti rahi
```

Upar wali kadi theek karo to neeche wale masle khud kam ho jayenge. Isliye ye priority order me likha hai.

---

## P0-1. Script nahi di gayi, naam Whisper se aaye (sab se badi jarr)

**Saboot:** `[align] mode=transcript`, `glossaryCorrections 1`.

Product naam galat hain:
- `Impactyt 3`
- `Mechanics Wear Impactyt 3` (asal me Mechanix Wear, aur model shayad "Impact" kuch)
- `3M Impeltor Comtac 8` (asal me 3M Peltor ComTac VIII)
- `null`
- `Explorer`

Galat naam ka matlab YouTube pe koi title match nahi karega:
`16 result(s), 0 name "R40 Personal Utility Ruck Case"`.

**Wajah:** sirf voiceover upload hua, `script.txt` nahi. Is liye align ne Whisper ke shabd hi sach
maan liye. Glossary me sirf 1 correction tha.

**Fix ka raasta:**
- Script ka text hamesha saath do (Mode A + script), ya kam az kam product list do.
- Agar script nahi hai to product naamon ki tasdeeq karo: web search karke spelling theek ho, phir aage chalo.

## P0-2. Brand/model ka batwara bina check ke

**Saboot:**
- `Impactyt 3: model "" has no letters or digits`
- `Caldwell Emax Shadows Pro: model ""`
- `null: brand and model are required`
- Pelican ka model `"R40 Personal Utility Ruck Case"` bana, jo title me kabhi poora nahi likha hota.

**Wajah:** `src/lib/facts.ts` LLM se `manufacturer`/`model` leta hai, aur `src/lib/agents/autoFetch.ts:41`
unhe seedha harvest ko de deta hai. Teen cheezein check nahi hotin:
- model khaali ho
- product ka naam `"null"` string ho
- model me description bhara ho ("Personal Utility Ruck Case")

`src/lib/agents/youtube/ytExtractor.ts:60` `modelPattern` **poora** model title me maangta hai, isliye
lamba model = 0 match.

**Fix ka raasta:**
- Model ko chhota karo, sirf code/naam rakho: "R40", "Comtac VIII", "Emax Shadow".
- Khaali model aur `"null"` products ko reject karo.
- Duplicate products merge karo ("Explorer" = "Bounce Imaging Explorer").

## P0-3. Footage na mile to pas wale product ki clip chala di jaati hai (galat product dikhta hai)

**Saboot:** scene 39 se 70 tak taqreeban har sub-shot `hVnjXGfkg7c_2971.mp4/.jpg` hai. Ye ek hi clip
4 alag chapters (O-Lite, Mechanics Wear, Impactyt, Caldwell) pe chali.

**Wajah:** `src/commands/assets.ts` `vaultProductOf()`. Exact-only mode me jis product ka vault nahi hota,
use **qareeb tareen** product ka vault de diya jaata hai. Phir `src/lib/pacing.ts:735` ke paas jab kuch
naya nahi bachta to `forced` reuse hota hai.

Matlab sirf repeat nahi ho raha, **galat product** dikh raha hai. Ye channel ke liye repeat se bhi bura hai.
"Exact model only" policy ka maqsad hi yahi tha ke galat product na dikhe, aur ye fallback us maqsad ko tor deta hai.

**Fix ka raasta:**
- Kisi aur product ka vault kabhi mat do.
- Khaali chapter ke liye order:
  1. us product ki images (Amazon / brand site / Google images)
  2. Ken Burns
  3. spec card / graphic
- Render se pehle **hard fail** ya warning: "chapter X: 0 footage, video mat banao".

## P1-4. Sirf YouTube se footage, images ka source band hai

**Saboot:**
- `[official] ... no-brand - brand not in niches/auto.json official.brands`
- `generic stock is off`
- `photos 0s` har chapter me

Tum ne theek kaha: Amazon aur Google images pe in products ki bohat tasveerein hain. Lekin pipeline
unhe istemal hi nahi karti.

**Wajah:**
- Official press-kit sirf un brands ke liye chalta hai jo `niches/*.json official.brands` me likhe hon. Auto niche me koi brand nahi hai.
- Image search (crawler) exact-model pool me shamil nahi hai.

**Fix ka raasta:**
- Har product ke liye brand ki site aur retailer images ko automatic dhoondo.
- Model naam se tasdeeq karo (title / alt-text me model ho).
- Phir unhe vault me "image" items ki tarah daalo.

## P1-5. Niche ghalat: tactical gear ko "Kitchen appliances" samjha

**Saboot:** `video type: Kitchen appliances (auto-detect)`.

**Wajah:** `src/lib/nicheDetect.ts:55`. Prompt me misaal `label: e.g. "Kitchen appliances"` likhi hai,
aur kamzor local model (Qwen) ne misaal hi copy kar di. Iska asar:
- stock queries ("cinematic kitchen appliances")
- harvest `category` (CLIP "off-topic" ka faisla: `8 off-topic shot(s) rejected`)
- pacing

Sab ghalat category pe chale.

**Fix ka raasta:**
- Prompt se misaal hatao.
- Jawab ko script ke shabdon se check karo: script me "kitchen" ka zikr hi nahi to reject karo.
- Category project setting me khud chunne ka option do.

## P1-6. Spec bolte waqt wahi hissa nahi dikhta

**Saboot:**
- `0/3 part callout(s) located`, har product pe 0
- `[vision] verified 0 candidate(s)`
- `the vision model is too slow on the CPU (the GPU is not usable)`

**Wajah:** part ko frame me dhoondna vision model ka kaam hai, aur GPU wala Ollama beech me crash hua:
- `token repeat limit reached`
- `Qwen not reachable at localhost:11434`

Vision CPU pe skip ho gaya. Footage bhi nahi thi, to spec-moment clips (`harvestKeyword`) bhi nahi bane.

**Fix ka raasta:**
1. Pehle footage (P0) theek karo.
2. Phir spec ke liye `"{model} {spec}"` search karo (e.g. "Comtac VIII battery").
3. Vision fail ho to ye **log me bada warning** ho, chup-chaap skip na ho.

## P1-7. Local LLM bharosemand nahi

**Saboot:**
- `intro/outro LLM failed (422 ... did not match the expected format)`
- `GPU returned garbage`
- `segment routing LLM failed (503)`
- `subject tracking failed`

Iska natija:
- hook/outro heuristic se aaye (`no outro found`)
- 72 lines "generic_hook" ban gayin
- subject tracking band raha

**Fix ka raasta:**
- Run se pehle `doctor` me LLM health check karo.
- Beech me Ollama gire to step ko rok kar dobara try karo, khamoshi se heuristic pe mat jao.
- Ya ek aur model as fallback rakho.

## P2-8. Web app crash: `project.json` ka BOM

**Saboot:** `SyntaxError: Unexpected token '', ""... is not valid JSON at readProject (server.ts:132)`.

**Wajah:** `src/server/server.ts:132` `JSON.parse` BOM (`﻿`) nahi hatata. Windows Notepad ya
PowerShell `Set-Content` file ke shuru me BOM likh deta hai. Baqi code (`nicheDetect.ts`) BOM hatata hai,
lekin ye function nahi. Ek kharab file poori project list gira deti hai.

**Fix ka raasta:** BOM strip karo, aur kharab file pe crash ke bajaye us project ko "broken" dikhao.

## P2-9. Pacing / QA ne kharab video ko rokne ke bajaye bana diya

**Saboot:**
- `stock/unverified 100% (cap 20%)`, 9 chapters me
- `WARNING insufficient footage` sirf warning bana

**Wajah:** cap sirf log hota hai, enforce nahi hota.

**Fix ka raasta:** quality gate lagao. Har chapter ke liye:
- minimum verified footage %
- `forced reuse` ki had (e.g. 5%)

Had paar ho to render se pehle ruk jao aur batao kya kami hai.

---

## Theek karne ka order (meri salah)

1. **P0-1 + P0-2:** sahi product naam aur chhota model. Is ke bina baqi sab bekaar hai.
2. **P0-3:** doosre product ki footage band.
3. **P1-4:** images ka source (Amazon / brand / Google).
4. **P2-9:** quality gate, taake aisi video dobara ban hi na sake.
5. **P1-5, P1-6, P1-7:** niche, spec moments, LLM reliability.
6. **P2-8:** BOM (chhota fix).

## Abhi tum kya kar sakte ho (bina code change)

- Video ke saath `script.txt` do, sahi spellings ke saath.
- Ollama ko GPU pe stable rakho, ya `.env` me cloud LLM do.
- Kharab `project.json` (jo Notepad se save hui) ko VS Code me "UTF-8" (bina BOM) me save karo.
