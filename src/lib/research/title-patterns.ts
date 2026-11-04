/**
 * Title patterns from competitor (outlier) titles: the structures that work in a niche, as
 * abstract templates with the topic words removed, e.g. "Top {N} {X} for {YEAR}", "Don't Buy {X}
 * Until You See This", "{X} vs {Y}". The title agent writes NEW titles with these structures; it
 * never reuses a competitor's wording (see the similarity check in src/lib/agents/titles.ts).
 */

export interface TitlePattern {
  id: string;
  label: string;
  template: string;
  re: RegExp;
}

export const PATTERNS: TitlePattern[] = [
  { id: "countdown", label: "Numbered list", template: "Top {N} {X} ({YEAR})", re: /^(top|the)?\s*\d+\s+\w+/i },
  { id: "best_year", label: "Best of the year", template: "Best {X} in {YEAR}", re: /\bbest\b.*\b20\d\d\b|\b20\d\d\b.*\bbest\b/i },
  { id: "versus", label: "Head to head", template: "{X} vs {Y}: {RESULT}", re: /\bvs\.?\b|\bversus\b/i },
  { id: "warning", label: "Warning / don't buy", template: "Don't Buy {X} Until You Watch This", re: /\b(don'?t|never|stop|avoid|before you buy|watch this before|mistake)/i },
  { id: "budget", label: "Budget angle", template: "{N} {X} Under ${PRICE} That Punch Above Their Weight", re: /\b(under|below|cheap|budget|affordable)\b.*\$?\d+|\$\d+/i },
  { id: "only", label: "The only one", template: "The Only {X} You'll Ever Need", re: /\bonly\b.*\b(need|buy)\b/i },
  { id: "secret", label: "Curiosity / secret", template: "Why Nobody Talks About {X}", re: /\b(nobody|no one|secret|hidden|truth|they don'?t want)\b/i },
  { id: "question", label: "Question", template: "Is {X} Still Worth It in {YEAR}?", re: /\?\s*$/ },
  { id: "tested", label: "Tested / proof", template: "I Tested {N} {X} - Here's the Winner", re: /\b(tested|tried|after \d+|years? later|review)\b/i },
  { id: "ranked", label: "Ranked / tier list", template: "Every {X} Ranked From Worst to Best", re: /\b(ranked|ranking|tier list|worst to best)\b/i },
  { id: "made_in", label: "Made in / origin", template: "{X} Still Made in America (Not China)", re: /\bmade in\b/i },
];

export interface PatternStats {
  pattern: TitlePattern;
  count: number;
  share: number;
  /** Mean views of titles with this pattern (when views are known). */
  meanViews: number | null;
}

export interface TitleStyle {
  patterns: PatternStats[];
  avgLength: number;
  /** Share of titles with a number, a year, brackets / parentheses, an ALL-CAPS word, a question mark. */
  numberShare: number;
  yearShare: number;
  bracketShare: number;
  capsShare: number;
}

const share = (xs: boolean[]) => (xs.length ? Math.round((xs.filter(Boolean).length / xs.length) * 100) / 100 : 0);

export function analyzeTitles(titles: { title: string; views?: number }[]): TitleStyle {
  const patterns = PATTERNS.map((p) => {
    const hits = titles.filter((t) => p.re.test(t.title));
    const withViews = hits.filter((t) => typeof t.views === "number");
    return { pattern: p, count: hits.length, share: titles.length ? Math.round((hits.length / titles.length) * 100) / 100 : 0, meanViews: withViews.length ? Math.round(withViews.reduce((s, t) => s + t.views!, 0) / withViews.length) : null };
  })
    .filter((p) => p.count > 0)
    .sort((a, b) => (b.meanViews ?? 0) * b.count - (a.meanViews ?? 0) * a.count || b.count - a.count);
  return {
    patterns,
    avgLength: titles.length ? Math.round(titles.reduce((s, t) => s + t.title.length, 0) / titles.length) : 0,
    numberShare: share(titles.map((t) => /\d/.test(t.title))),
    yearShare: share(titles.map((t) => /\b20\d\d\b/.test(t.title))),
    bracketShare: share(titles.map((t) => /[([]/.test(t.title))),
    capsShare: share(titles.map((t) => /\b[A-Z]{3,}\b/.test(t.title))),
  };
}

/** Templates to try, best-performing first, filled up with the generic ones. */
export function templatesFor(style: TitleStyle, n = 6): string[] {
  const own = style.patterns.map((p) => p.pattern.template);
  const rest = PATTERNS.map((p) => p.template).filter((t) => !own.includes(t));
  return [...own, ...rest].slice(0, n);
}
