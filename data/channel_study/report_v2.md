# Channel study v2: how faceless listicle channels build visuals

Method: yt-dlp search (16 queries/niche) + seed channels -> channels_50.md (55/niche listed). 3 videos/channel targeted (330 jobs); 224 downloaded+analyzed (first 300 s, 360p, no audio) + YouTube auto-captions (json3 word timings). PySceneDetect ContentDetector(27) for cuts; 1 mid-frame per shot classified with CLIP ViT-B/32 zero-shot (fastembed). Captions split into phrases (gap>0.7s or 14 words), phrase type by keyword regex. Channels with >=15% talking-head screen time excluded from stats. All videos deleted after analysis.


## tech

- Analyzed: 47 channels / 103 videos; faceless kept: **39 channels / 85 videos** (excluded talking-head: @Mrwhosetheboss, @SmartHomeSolver, @ToastyBros, @Top5best, @howtomen, @infinite, @itsemilyleah, @randomfrankp)
- Shot length: median **1.8 s**, mean 2.45 s, IQR 1.13-2.93 s; 55.7% under 2 s, 4.9% over 6 s
- Cuts/min (median per video): **25.8** (IQR 19.4-30.9)
- Product segment: median 39.3 s, **16.0 shots/product** (IQR [11.0, 22.25]), n=190 segments
- Cards (rank/text) appear in 26.8% of product segments; first card median 18.5 s after the product-intro phrase
- Source mix (% screen time): handson 45.4%, field 14.5%, promo 11.8%, amazon 9.6%, lifestyle 9.0%, talking 4.2%, rankcard 2.8%, other 1.9%, textcard 0.7%

| sentence type | phrases | top shot types (% time) | over-represented (lift) |
|---|---|---|---|
| hook | 569 | handson 40.8, field 17.7, lifestyle 10.9, promo 9.4 | rankcard x1.68 |
| use_case | 602 | handson 52.6, field 16.5, promo 8.8, lifestyle 8.5 |  |
| price | 141 | handson 31.6, amazon 17.8, rankcard 13.3, field 12.2 | rankcard x4.75, amazon x1.85 |
| other | 6097 | handson 48.0, field 12.1, promo 12.0, amazon 9.4 |  |
| product_intro | 344 | handson 34.6, promo 16.7, amazon 16.1, field 15.4 | amazon x1.68, textcard x1.57, rankcard x1.54, promo x1.42 |
| spec | 445 | handson 41.1, field 15.7, promo 12.1, lifestyle 10.8 | other x1.63 |
| verdict | 106 | handson 48.4, amazon 15.3, promo 12.1, lifestyle 7.3 | amazon x1.59 |

## guns

- Analyzed: 54 channels / 121 videos; faceless kept: **40 channels / 89 videos** (excluded talking-head: @3of7Project, @ClassicFirearms, @ColionNoir, @Godfamilyandguns, @PewView, @TacticalConsiderations, @TexasPlinking, @ThePreparedWanderer, @WarriorPoetSociety, @backfire, @bigboytoys7115, @gideonstactical, @sootch00, @tfbtv)
- Shot length: median **2.2 s**, mean 3.16 s, IQR 1.27-3.57 s; 44.9% under 2 s, 8.2% over 6 s
- Cuts/min (median per video): **19.8** (IQR 12.2-25.3)
- Product segment: median 67.1 s, **16.0 shots/product** (IQR [9.0, 30.0]), n=182 segments
- Cards (rank/text) appear in 45.1% of product segments; first card median 17.7 s after the product-intro phrase
- Source mix (% screen time): field 70.5%, handson 9.5%, promo 4.7%, amazon 4.2%, rankcard 2.9%, talking 2.7%, lifestyle 2.3%, other 1.9%, textcard 1.3%

| sentence type | phrases | top shot types (% time) | over-represented (lift) |
|---|---|---|---|
| hook | 640 | field 73.8, handson 8.1, talking 3.5, amazon 3.3 | other x1.53, talking x1.3 |
| other | 6740 | field 70.6, handson 9.8, promo 4.9, amazon 4.1 |  |
| product_intro | 348 | field 59.0, rankcard 10.4, handson 7.6, amazon 7.1 | textcard x4.85, rankcard x3.59, amazon x1.69 |
| spec | 854 | field 75.4, handson 7.7, amazon 5.4, promo 3.6 |  |
| price | 441 | field 63.1, handson 9.2, rankcard 9.1, promo 8.7 | rankcard x3.14, promo x1.85 |
| use_case | 386 | field 69.0, handson 13.7, promo 4.4, lifestyle 3.6 | lifestyle x1.57, handson x1.44 |
| verdict | 114 | field 79.0, talking 4.4, rankcard 4.0, handson 3.6 | talking x1.63, other x1.42, rankcard x1.38 |

## Takeaways for ClipForge
- Pacing: tech ~1.8 s median shots (~26 cuts/min); guns ~2.2 s (~20 cuts/min). Cut on time, not on sentences: cuts-per-phrase median is 1 for every sentence type.
- ~16 shots per product in both niches -> need a 15-30 clip pool per product.
- Tech is dominated by hands-on/review footage (~45%); promo + product photos ~21%. Guns is dominated by gun-in-use/range/close-up footage (~70%).
- Price phrases: rank/price card lift x4.75 (tech) / x3.1 (guns), product photo lift x1.85 tech. Product-intro phrases: rank card + spec text card + official photo over-represented (guns textcard x4.85, rankcard x3.6).
- Verdict phrases in tech favor product photos (x1.6). Use-case phrases in guns favor hands-on/lifestyle.

## Limitations
- 224 of 330 target videos analyzed (106 downloads failed; likely AV1-only formats, age-restriction or availability, reasons not individually checked); channels with >=1 video: tech 47, guns 54; faceless after filter 39 / 40. Not every channel has 3 videos.
- Only first 5 minutes per video: the hook/intro is over-weighted; product segments that end after 5 min are not counted.
- CLIP zero-shot is approximate. Spot check of 24 frames (v2/check/grid.png) looked mostly right, but for guns the "field" class also absorbs gun close-ups/product b-roll (not only range shots), so treat guns "field" as "gun footage, any". Cards with overlaid text on video are often classed as the underlying footage, so card % is a lower bound.
- Sentence types come from keyword regex on auto-captions (no punctuation); "other" is the largest bucket. Faceless status inferred from CLIP talking-head share, not manually verified.
- Cut detection misses dissolves/zoom-only motion (shot lengths slightly overestimated).