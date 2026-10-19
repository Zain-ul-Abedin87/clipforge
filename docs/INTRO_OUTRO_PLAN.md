# Plan: Intro, Outro, General lines aur Remotion effects

Branch: `feature/general-web-crawler` · Abhi sirf plan hai, code nahi likha.

---

## 1. Masla kya hai (code se confirm kiya)

### Intro: video ka sab se kamzor hissa
- `src/lib/planner/label.ts:83`: intro section ka **pehla poora scene** ek graphic card ban jata hai. Uska title hardcoded `"Top Picks"` hai, script se nahi aata.
- `src/lib/assets/graphics.ts:164`: card par likha hota hai `TODAY'S COUNTDOWN` + `TOP PICKS`. Yeh static drawtext PNG hai, Remotion animation nahi.
- `src/commands/timeline.ts:332`: card ke peeche **qareeb wale scene ki footage, blur aur dark kar ke** lagti hai.
- Scenes ki validation 6-12 sec maangti hai (`src/lib/scenes.ts:52`). Yani video ke pehle **6 se 12 second** viewer ko blur footage par ek generic text dikhta hai, jab ke narrator hook bol raha hota hai.

**Yeh kyun bura hai:** YouTube Studio ka "Intro" metric batata hai ke 30 second ke baad kitne log abhi bhi dekh rahe hain. YouTube khud kehta hai ke yeh number girne par pehle 30 second badlo ([YouTube Help](https://support.google.com/youtube/answer/9314415?hl=en)). Hamara pehla hissa hi sab se kam visual hai.

### Outro
- `label.ts:86`: aakhri scene `"Thanks for watching"` / `SEE YOU NEXT TIME` card ban jata hai, wahi blur footage ke saath.
- YouTube end screen elements video ke **aakhri 5-20 second** mein lagte hain, aur video kam az kam 25 second ki honi chahiye ([YouTube Help](https://support.google.com/youtube/answer/6388789)). Hamara outro un elements ke liye jagah plan nahi karta. End screen ke buttons hamare text ke upar aa kar takrate hain.

### General lines ("what do you think about that?")
- `src/lib/planner/segmentRoute.ts:42`: aisi lines `generic_hook` ban jati hain. LLM ko saaf likha hai: cinematic queries do, **"no people talking"**.
- `src/commands/assets.ts:365`: woh cinematic queries har scene ko **round-robin mein** milti hain (`r = (noWebIds.size * 2) % c.length`), line ke matlab se nahi.
- `src/lib/pacing.ts:532` (`GENERIC_PRODUCT_BROLL`): general line ke liye kuch na mile to **product ki footage** daal di jati hai.
- **Nateeja:** "What do you think?" par lawn ka aerial shot ya mower ki close-up aati hai. Real editor wahan sochta hua, kandhe uchkata ya comment karta hua insaan dikhata.

### Remotion
- `cards/src/Root.tsx` mein 11 compositions hain: Rank, Price, Spec, LowerThird, SpecBars, ProsCons, PriceTag, CompareTable, Gauge, PartCallout, PhotoParallax.
- **Sab product data cards hain.** Intro, hook, outro, sawal, emphasis ya bara number ke liye ek bhi nahi.
- `@remotion/transitions` (`TransitionSeries`) use nahi ho raha.

---

## 2. Baqi tools aur editors kya karte hain

Main sirf woh likh raha hoon jo verify ho saka. Vendor ka apna daawa alag se mark kiya hai.

| Kaun | Kya karta hai | Source ki quality |
|---|---|---|
| YouTube (official) | Pehle 30 sec ko "Intro" key moment ke taur par naapta hai. Agar log jaldi chale jayein to title/thumbnail aur pehle 30 sec badalne ko kehta hai. | Official ([link](https://support.google.com/youtube/answer/9314415?hl=en)) |
| YouTube (official) | End screen: aakhri 5-20 sec, video ≥25 sec, 16:9 par max 4 elements. | Official ([link](https://support.google.com/youtube/answer/6388789)) |
| YouTube monetization | Jul 2025 se "repetitious content" ka naam "inauthentic content" ho gaya. Sirf "superficial differences" wali mass-produced videos, ya ek jaisi narration wale slideshows, monetization kho sakte hain. | News outlets ne TeamYouTube ka bayan quote kiya ([SEJ](https://www.searchenginejournal.com/youtube-clarifies-monetization-update-targeting-spam-not-reaction-channels/550123/), [ppc.land](https://ppc.land/youtube-clarifies-inauthentic-content-policy-changes/)). Primary YouTube page main khud nahi khol saka. |
| InVideo | Har sentence ke keywords **aur sentiment** dekh kar clip chunta hai. Wide, close-up aur angles mix karta hai. | **Vendor ka apna blog**, verified nahi ([link](https://info.invideo.io/blog/automatic-b-roll-selection-video-script-invideo)) |
| Pictory | Har sentence ek scene, stock library se match. | Sirf third-party review ([link](https://fast.io/resources/pictory-ai-review-2026/)) |
| Remotion | `TransitionSeries` sequences ke beech transitions lagata hai. `springTiming` / `linearTiming` deta hai. Transition saath wale sequence se lamba nahi ho sakta. | Official docs ([link](https://www.remotion.dev/docs/transitions/timings/lineartiming), [TransitionSeries](https://convert.remotion.dev/docs/transitions/transitionseries)) |

**Imandari se:** "intro 3-8 sec ka ho" jaise numbers sirf blogs mein mile ([vidIQ](https://vidiq.com/blog/post/youtube-video-intros/), [teleprompter.com](https://www.teleprompter.com/blog/how-long-should-a-youtube-intro-be)), YouTube ke official page par nahi. Is liye plan mein inhein rule nahi, sirf **starting default** rakha hai. Asal faisla aapke apne Studio "Intro" number se hoga.

---

## 3. "General line par random log" wala idea: meri raaye

**Idea sahi hai, lekin "random" galat lafz hai.** Real editor random clip nahi lagata. Woh line ka **irada (intent)** dekhta hai:

| Line ki qisam | Misaal | Editor kya dikhata hai |
|---|---|---|
| Audience se sawal | "What do you think about that?", "Have you ever...?" | Sochta hua insaan, sar khujata, dost baat karte hue |
| Comment / like CTA | "Let me know in the comments" | Phone par type karta haath, thumbs-up |
| Rai / jazbaat | "Honestly, I was shocked", "I love this" | Hairan chehra, muskurahat, reaction |
| Masla / twist | "But here's the problem...", "Most people get this wrong" | Frustration, kuch toot-ta hua, confused face |
| Statistic | "73% of buyers..." | **Footage nahi.** Bara animated number (Remotion) |
| Transition | "Next up...", "Moving on" | Fast whip / product tease |

**Khatray (yeh na kiya to video saste stock jaisi lagegi):**
1. **Camera ki taraf bolta hua insaan nahi.** Uske hont hil rahe hon aur awaaz narrator ki ho to fake lagta hai. Sirf reaction aur gesture clips.
2. **Hadd lagao.** Har teesri line par stock insaan aaye to cliché ban jata hai. Main ~15% cap aur kam az kam 20 sec ka gap rakhunga.
3. **Har video mein naye log.** Har video mein wahi "confused man" clip aaye to woh hi "superficial differences" wala pattern hai jo YouTube ke inauthentic-content bayan mein hai. Footage library (`footageLibrary.ts`) se pichli videos mein use hui clips avoid hongi.
4. **Statistic ya data wali line par insaan nahi, graphic.** Wahan log dikhana bhaari lagta hai.

---

## 4. Plan (kis tarteeb mein)

### Phase 1: Intro / cold open (sab se zaroori)
1. **Static intro card khatam.** `label.ts:83` intro ke pehle scene ko card nahi banayega, footage scene banayega.
2. **0-3 sec ka "teaser montage":** video ke sab se strong verified pool shots, har ek 0.6-1 sec, fast cuts. Real editor yahi karta hai: pehle payoff dikhao.
3. **Hook text script se:** pehla sentence ya video ka title, word-by-word kinetic text, `aligned.json` ki timing se synced. `"Top Picks"` hardcode khatam.
4. **Intro ka pacing tez:** `openingFactor` pehle se maujood hai. Intro section mein 2-4 sec ki jagah 1.5-2.5 sec.
5. **Nayi Remotion compositions:**
   - `HookTitle`: kinetic words, keyword highlight, punch-in.
   - `CountdownTeaser`: "5 → 1" numbers, har number ke saath us product ka chhota thumbnail flip.
6. **Card ka time max ~1.5 sec**, poora scene kabhi nahi.

### Phase 2: Outro
1. Outro section pehle se detect hota hai (`structure.ts:91`).
2. **Recap montage:** winner product ki 2-3 shots + Remotion `RecapStack` (ranked list, thumbnails, "Best overall" highlight).
3. **End-screen-safe layout:** agar video ≥25 sec hai to aakhri ~15 sec (5-20 ke andar, setting se badal sakein) mein Remotion `EndScreenLayout`. Background par slow B-roll loop, aur YouTube elements ke liye khaali jagahen jahan hamara text na aaye.
4. "Subscribe" / "comment" wali lines par animated subscribe-button ya comment-icon overlay.
5. Static "SEE YOU NEXT TIME" card khatam.

### Phase 3: General lines ke liye intent-based B-roll
1. **Naya `lineIntent` step** (plan stage mein, `segmentRoute.ts` ke saath): LLM line ko upar wali table ki qisam deta hai. LLM na ho to regex fallback ("what do you think|let me know|have you ever|honestly|here's the problem|\d+%").
2. **Intent ke hisaab se query bank** (niche file mein, badal sakein):
   - `audience_question` → "person thinking", "man shrugging", "friends discussing"
   - `cta` → "typing on phone", "thumbs up"
   - `emotion` → "surprised face", "smiling person"
   - `problem` → "frustrated person", "broken"
3. **Round-robin ki jagah meaning se** (`assets.ts:365`): intent wali line apni intent queries pehle use karegi, cinematic baad mein.
4. **Statistic** lines → Remotion `BigNumber` card, footage nahi.
5. In intents par `GENERIC_PRODUCT_BROLL` band (`pacing.ts:532`). Product footage sirf tab jab line product ke baare mein ho.
6. **Filters:** vision check se camera ki taraf bolte chehre reject, ~15% people cap, 20 sec gap, pichli videos ki clips avoid.

### Phase 4: Remotion effects behtar
1. **Emphasis:** script ke important lafz (number, "best", "never") par halka punch-in zoom aur text pop.
2. **Transitions sirf chapter boundary par**, `@remotion/transitions` se (whip/slide, `springTiming`). Har cut par nahi, warna saste template jaisa lagta hai.
3. **Card theme har video mein thoda badle** (accent color / layout variant). Har video ka intro bilkul ek jaisa na ho; "inauthentic content" wale bayan ko dekhte hue yeh zaroori hai.
4. Mojooda cards (`Rank`, `LowerThird`) mein entrance ke saath exit animation bhi, taake cut par achanak gayab na hon.

### Phase 5: QA checks (taake yeh dobara na bigre)
- Pehle 3 sec mein moving footage hai (static card nahi).
- Koi intro/outro card 2 sec se lamba nahi.
- Video ≥25 sec ho to end-screen zone mein koi zaroori text nahi.
- Hardcoded generic titles ("Top Picks", "Thanks for watching") screen par nahi.
- People-reaction shots ka share 15% se kam.

---

## 5. Kaise naapein ke behtar hua

- **Asli metric:** YouTube Studio → Analytics → "Key moments for audience retention" → **Intro** (30 sec par kitne % log baqi) ([YouTube Help](https://support.google.com/youtube/answer/9314415?hl=en)). Purani 3-5 videos ka number note karein, phir nayi wali se compare.
- Outro ke liye: end screen element click-rate (Studio mein).
- Ek video se faisla na karein. Kam az kam 3-5 videos ka average dekhein.

## 6. Kya main nahi kar sakta / risk

- Stock sites (Pexels/Pixabay) par achhi "reaction" clips ki tadaad niche ke hisaab se kam ho sakti hai. Main ne yeh search karke check nahi kiya, kyun ke sandbox se un APIs tak pahunch nahi hai.
- InVideo/Pictory ka asal internal tareeqa public nahi. Upar sirf unka apna ya reviewers ka bayan hai.
- Phase 1 aur 3 ka faida pehli 3-5 videos ke Studio data se pata chalega. Pehle se guarantee nahi di ja sakti.
