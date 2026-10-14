/** Where a clip or photo came from (tier order is decided by the niche rule set). */
export type Source = "local" | "presskit" | "wikimedia" | "pexels" | "pixabay" | "unsplash" | "archive" | "youtube_cc" | "web_cc" | "storyblocks" | "web_crawl";

/** assets.json contract: {scene_id: {path,source,license,url}} plus what the renderer needs. */
export interface Asset {
  path: string;
  source: Source | "graphic";
  license: string;
  url: string;
  kind: "video" | "image";
  author?: string;
  width?: number;
  height?: number;
  duration?: number;
  /** Seconds into the clip where this scene starts (so reused clips show different footage). */
  in?: number;
  thumb?: string;
  /** What the resolver looked for, shown in the review page. */
  query?: string;
  /** Set when a lower tier was used because a better one had nothing (e.g. product media missing). */
  note?: string;
  /** CLIP similarity between the scene and the chosen clip's thumbnail (higher = better match). */
  match?: number;
}

export type Assets = Record<string, Asset>;

export interface Candidate {
  source: Source;
  id: string;
  kind: "video" | "image";
  /** Local path, or remote download URL for stock. */
  location: string;
  pageUrl: string;
  license: string;
  author?: string;
  width: number;
  height: number;
  duration?: number;
  score: number;
  /** Title/tags from the stock site, checked against the niche's blocked terms. */
  tags?: string;
  /** Small preview image URL, used to judge relevance before downloading the clip. */
  thumbUrl?: string;
  /** Full length of the remote source when only a piece is fetched (Archive.org films). */
  sourceLength?: number;
  /** Local frame JPEGs (up to 3) for CLIP / vision scoring, e.g. per-shot frames of a web_crawl preview. */
  frames?: string[];
  /** Seconds into the remote source where this shot starts (web_crawl: only this part is fetched in HD). */
  shotStart?: number;
}
