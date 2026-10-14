# Channel study v3: how faceless listicle channels build visuals

Method: yt-dlp discovery (queries + seed channels) -> large channel pool; rank0 + faceless rank1 download/analysis. Per video: up to three **120 s windows** (start / mid / end), 360p decode, YouTube auto-captions (json3 word timings). Cut detection on frame diffs; 1 mid-frame per shot classified with **CLIP ViT-B/32** zero-shot (fastembed), including a dedicated **gun_closeup** class. Captions split into phrases (gap>0.7s or 14 words), phrase type by keyword regex. Channels with **>=15% talking-head** screen time excluded from stats. Videos deleted after analysis. Aggregation over **957** analyzed result JSONs (560 rank0 + 398 phase2 faceless; 16 YouTube-blocked pending + 1 download fail left out).

## tech

- Analyzed: **279 channels / 477 videos**; faceless kept: **198 channels / 381 videos** (excluded talking-head sample: @51Drones, @9to5Mac, @AI.Uncovered, @AmericasTestKitchen, @ApolloScooters, @ByteReview, @CEONTHEMAKING, @ChinaCore123, @DHRME, @DOPEorNOPE, @ELJefeReviews, @ESG-ElectricScooterGuide, … (+69 more))
- Shot length: median **2.07 s**, mean 3.04 s, IQR 1.26-3.6 s; 47.6% under 2 s, 9.1% over 6 s
- Cuts/min (median per video): **19.5** (IQR 13.83-24.33); by window position: start 21.5, middle 18.0, end 17.5
- Product segment: median 38.4 s, **12 shots/product** (IQR [8.0, 18.0]), n=531 segments
- Cards (rank/text) appear in 28.1% of product segments; first card median 13.8 s after the product-intro phrase
- Source mix (% screen time): handson 40.8%, lifestyle 13.8%, amazon 12.4%, promo 10.7%, field 10.2%, talking 3.5%, other 2.6%, rankcard 2.4%, gun_closeup 2.1%
- Transitions: hard 75.8%, soft 15.0%, flash 6.4%, fade_black 2.9%; videos using flash ≥2% of cuts: 83.7%
- Motion on still-class shots (amazon/promo/textcard/rankcard): static 52.9%, zoom_in 20.0%, pan 16.8%, zoom_out 10.3%
- Text overlays (OCR-sampled shots): overlay text on 46.1%; burned caption-line style 3.8%; largest-text positions top: bottom-center 19.4%, middle-center 18.1%, bottom-left 15.7%, top-left 14.0%; case Title/mixed 53.7%, UPPER 41.1%, lower 5.3%; median text height frac 0.083, median words/overlay 3.0
- Music bed detected in **77.9%** of measured videos (n=367); speech−pause median 14.9 dB
- Corner watermark videos: 6.3%; subscribe-popup style text in 15.5% of faceless videos

| sentence type | mapped s | top shot types (% time) | over-represented (lift) |
|---|---|---|---|
| hook | 7709 | handson 38.0, lifestyle 16.2, promo 11.3, field 11.1 | rankcard x1.54, talking x1.4 |
| product_intro | 4803 | handson 35.8, amazon 15.4, lifestyle 13.3, promo 13.1 | rankcard x1.71 |
| use_case | 10611 | handson 47.0, lifestyle 12.3, amazon 10.6, field 10.4 |  |
| spec | 9120 | handson 37.1, lifestyle 15.6, amazon 14.9, promo 11.1 | textcard x1.44 |
| price | 4661 | handson 32.1, amazon 20.1, lifestyle 12.2, field 11.5 | rankcard x2.0, amazon x1.62, textcard x1.38, other x1.31 |
| verdict | 2456 | handson 45.8, lifestyle 12.6, amazon 11.3, field 9.4 |  |
| other | 91895 | handson 40.6, lifestyle 13.8, amazon 12.3, promo 10.7 |  |

## guns

- Analyzed: **280 channels / 480 videos**; faceless kept: **190 channels / 378 videos** (excluded talking-head sample: @110sassactual, @1ShotTV, @1stShotTactical, @3of7Project, @AAROnair, @ArcheryTalkVideo, @At3tactical, @BestDamnEDC, @BlackScoutSurvival, @CharlieSurvival, @ClassicFirearms, @ColionNoir, … (+78 more))
- Shot length: median **2.53 s**, mean 3.99 s, IQR 1.47-4.34 s; 37.3% under 2 s, 13.4% over 6 s
- Cuts/min (median per video): **14.3** (IQR 8.79-20.33); by window position: start 16.0, middle 13.0, end 13.0
- Product segment: median 46.3 s, **11.0 shots/product** (IQR [6.0, 17.75]), n=388 segments
- Cards (rank/text) appear in 29.9% of product segments; first card median 10.9 s after the product-intro phrase
- Source mix (% screen time): gun_closeup 34.8%, field 27.8%, handson 19.0%, amazon 4.5%, lifestyle 3.7%, promo 2.7%, rankcard 2.3%, talking 2.1%, other 1.7%
- Transitions: hard 74.4%, soft 14.6%, flash 7.4%, fade_black 3.5%; videos using flash ≥2% of cuts: 64.6%
- Motion on still-class shots (amazon/promo/textcard/rankcard): static 49.7%, zoom_in 26.7%, pan 12.9%, zoom_out 10.7%
- Text overlays (OCR-sampled shots): overlay text on 35.9%; burned caption-line style 2.2%; largest-text positions top: middle-center 19.4%, bottom-center 18.3%, top-right 15.5%, top-left 12.2%; case UPPER 62.0%, Title/mixed 33.8%, lower 4.2%; median text height frac 0.088, median words/overlay 2.0
- Music bed detected in **63.9%** of measured videos (n=374); speech−pause median 17.9 dB
- Corner watermark videos: 13.0%; subscribe-popup style text in 13.5% of faceless videos

| sentence type | mapped s | top shot types (% time) | over-represented (lift) |
|---|---|---|---|
| hook | 7995 | field 33.9, gun_closeup 29.1, handson 15.0, lifestyle 6.2 | lifestyle x1.68, other x1.47, promo x1.41, talking x1.38 |
| product_intro | 4746 | gun_closeup 34.4, field 23.9, handson 16.5, amazon 6.0 | rankcard x2.39, textcard x2.13, promo x1.48, amazon x1.33 |
| use_case | 8260 | gun_closeup 33.1, field 27.4, handson 21.4, lifestyle 4.9 | lifestyle x1.32 |
| spec | 10491 | gun_closeup 44.3, field 33.4, handson 9.4, amazon 3.0 | textcard x1.33 |
| price | 6617 | gun_closeup 38.2, field 25.7, handson 17.9, amazon 5.1 | rankcard x2.09 |
| verdict | 2768 | gun_closeup 37.1, field 29.0, handson 19.3, amazon 4.9 |  |
| other | 92731 | gun_closeup 34.4, field 27.2, handson 19.8, amazon 4.6 |  |

## Takeaways for ClipForge
- Pacing: tech ~2.1 s median shots (~19.5 cuts/min); guns ~2.5 s (~14.3 cuts/min). Slightly slower than v2 first-5-min sample — mid/end windows cut less often than the cold open.
- ~11–12 shots per product segment (median) → keep a **12–25 clip pool per product** (v2 was ~16; multi-window still needs a deep B-roll shelf).
- Tech mix: handson ~41%, lifestyle ~14%, amazon+promo ~23%. Guns mix: **gun_closeup ~35% + field ~28%** dominate; handson ~19%. Prefer close-up product + range/use footage for guns, not talking-head.
- Price / product-intro: rankcard lift ~x2.0–2.4; textcard lift strong on guns intros (x2.1). Amazon photos lift on tech price (x1.6) and product_intro.
- Still photos rarely stay static: ~47–50% of still-class shots get zoom/pan Ken-Burns; favor mild zoom-in over static holds.
- Hard cuts dominate (~75%); soft ~15%; flash used in a majority of videos (esp. tech ~84%). Music bed under VO is common (tech ~78%, guns ~64%).
- Text overlays: short (median 2–3 words), Title/mixed or UPPER, often bottom- or middle-center; generate rank/price cards early in each product block (~11–14 s after intro phrase).

## Limitations
- **957** of ~975 target analyses completed; **16** downloads still YouTube bot-blocked and **1** download fail (`WWA6M2agAx4`) were not re-tried. Faceless filter is CLIP talking-head share, not manual review.
- Multi-window (start/mid/end ≤120 s) improves coverage vs v2 first-5-min, but long middle stretches between windows are unsampled; product segments that never hit a window are missed.
- CLIP zero-shot is approximate. Guns **gun_closeup** helps separate table/detail from range **field**, but mislabels still happen; cards overlaid on video are often classed as the underlying footage, so card % is a lower bound.
- Sentence types come from keyword regex on auto-captions (no punctuation); "other" is the largest bucket. Phrase table "mapped s" is overlapped shot×phrase screen time, not raw phrase counts.
- Cut detection misses dissolves/zoom-only motion (shot lengths slightly overestimated). OCR watermark/subscribe heuristics are noisy.
