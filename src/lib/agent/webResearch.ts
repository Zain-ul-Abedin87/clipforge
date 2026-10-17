import fs from "node:fs";
import path from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { env, hasKey } from "../env.js";
import { paths } from "../paths.js";
import { slug } from "../assets/presskit.js";
import { llm, llmAvailable } from "../agents/llm/llm.js";

/**
 * Web research for a product (Claude + the server-side web_search tool): finds the manufacturer's
 * own product page and official press / newsroom pages, plus 3-4 short spec facts for on-screen
 * callouts. Only official sources are returned; retailers, reviews and video sites are left out.
 * Results are cached per channel and product in presskit/<product>/research.json (re-used by every
 * video on that channel; refreshed after 30 days).
 */

export interface ResearchPage {
  url: string;
  kind: "product_page" | "press_kit" | "newsroom";
  publisher: string;
}

export interface ProductResearch {
  product: string;
  pages: ResearchPage[];
  /** Short on-screen facts, e.g. "9mm", "15+1 rounds", "$499 MSRP". */
  specs: string[];
  searches: number;
  model: string;
  at: string;
}

const REFRESH_DAYS = 30;

const ReportSchema = z.object({
  pages: z.array(
    z.object({
      url: z.string(),
      kind: z.enum(["product_page", "press_kit", "newsroom"]),
      publisher: z.string(),
      official: z.boolean(),
    }),
  ),
  specs: z.array(z.string()),
});

const REPORT_TOOL: Anthropic.Beta.BetaTool = {
  name: "report_product_research",
  description: "Report the official pages and spec facts you found for the product. Call this exactly once, at the end.",
  strict: true,
  input_schema: {
    type: "object",
    additionalProperties: false,
    required: ["pages", "specs"],
    properties: {
      pages: {
        type: "array",
        description: "Up to 4 official pages, best first. Empty when none was found.",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["url", "kind", "publisher", "official"],
          properties: {
            url: { type: "string", description: "Full https URL of the page." },
            kind: { type: "string", enum: ["product_page", "press_kit", "newsroom"] },
            publisher: { type: "string", description: "Company that runs the site, e.g. Ruger, Samsung." },
            official: { type: "boolean", description: "True only when the site belongs to the product's maker (or its official newsroom / media site)." },
          },
        },
      },
      specs: {
        type: "array",
        description: "3-4 short facts for on-screen chips, max 24 characters each, e.g. \"9mm Luger\", \"15+1 rounds\", \"$499 MSRP\", \"6.9-inch display\". No marketing claims.",
        items: { type: "string" },
      },
    },
  },
};

const SYSTEM = `You research one product for a YouTube video editor who needs the maker's own product photos.

Use web search to find:
1. The manufacturer's own product page for exactly this model (the page that shows this model's photos).
2. If they exist: the maker's official press kit / media / newsroom page for this model (these often offer high-resolution photos and B-roll for press use).

Rules:
- Only the maker's own sites count (e.g. ruger.com, news.samsung.com, apple.com/newsroom). Never retailers, marketplaces, review sites, forums, Wikipedia or video sites.
- The page must be about this exact model (variants such as colour, finish or calibre are fine), not a category or a different model.
- Also note 3-4 short, verifiable spec facts from the official page for on-screen chips (calibre/capacity/weight/price for firearms; display/chip/battery/price for tech). Keep each under 24 characters.
- Keep searching short: 1-3 searches are usually enough.
- Finish by calling report_product_research once. If nothing official exists, report an empty pages list.`;

export const webResearchEnabled = () => llmAvailable({ tools: true }) && env("WEB_RESEARCH", "on").toLowerCase() !== "off";
export const webResearchModel = () => env("WEB_RESEARCH_MODEL", "claude-opus-5-5");

const cacheFile = (channel: string, product: string) => path.join(paths.channels, channel, "presskit", slug(product), "research.json");

/** Tidies a spec fact; the model sometimes carries a calibre's dot over (".10+1 rounds"). */
function tidySpec(s: string): string {
  return s.replace(/\s+/g, " ").trim().replace(/^\.(?=\d+\s*\+\s*\d)/, "");
}

export function readResearch(channel: string, product: string): ProductResearch | null {
  try {
    const r = JSON.parse(fs.readFileSync(cacheFile(channel, product), "utf8")) as ProductResearch;
    return { ...r, specs: r.specs.map(tidySpec) };
  } catch {
    return null;
  }
}

/** Keeps only plausible official https pages and short spec strings. */
function clean(report: z.infer<typeof ReportSchema>): { pages: ResearchPage[]; specs: string[] } {
  const seen = new Set<string>();
  const pages: ResearchPage[] = [];
  for (const p of report.pages) {
    if (!p.official) continue;
    let u: URL;
    try {
      u = new URL(p.url);
    } catch {
      continue;
    }
    if (u.protocol !== "https:" && u.protocol !== "http:") continue;
    if (/(amazon|ebay|walmart|bestbuy|gunbroker|youtube|youtu\.be|wikipedia|reddit|facebook|instagram|tiktok|x\.com|twitter)\./i.test(u.hostname)) continue;
    if (seen.has(u.href)) continue;
    seen.add(u.href);
    pages.push({ url: u.href, kind: p.kind, publisher: p.publisher.slice(0, 60) });
  }
  const specs = [...new Set(report.specs.map(tidySpec).filter((s) => s && s.length <= 28))].slice(0, 4);
  return { pages: pages.slice(0, 4), specs };
}

/**
 * Cached research for `product`, or a fresh web search. `context` names the video type
 * ("firearms", "tech") to steer the spec facts. Returns null when research is off or fails.
 */
export async function researchProduct(
  channel: string,
  product: string,
  context: string,
  log: (m: string) => void,
  force = false,
): Promise<ProductResearch | null> {
  const cached = readResearch(channel, product);
  if (!force && cached && Date.now() - Date.parse(cached.at) < REFRESH_DAYS * 864e5) return cached;
  if (!webResearchEnabled()) return cached;

  const model = webResearchModel();
  const client = llm();
  const messages: Anthropic.Beta.BetaMessageParam[] = [
    { role: "user", content: `Product: ${product}\nVideo topic: ${context}\nFind the official product page, any official press/media page, and 3-4 spec facts.` },
  ];
  let searches = 0;
  const usage = { in: 0, out: 0 };
  try {
    for (let turn = 0; turn < 5; turn++) {
      const res = await client.beta.messages.create({
        model,
        max_tokens: 16000,
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default",
        output_config: { effort: "low" },
        system: SYSTEM,
        tools: [{ type: "web_search_20260209", name: "web_search", max_uses: 4 }, REPORT_TOOL],
        tool_choice: { type: "auto" },
        messages,
      });
      usage.in += res.usage.input_tokens;
      usage.out += res.usage.output_tokens;
      searches += res.usage.server_tool_use?.web_search_requests ?? 0;
      if (res.stop_reason === "refusal") {
        log(`[research] ${product}: request declined`);
        return cached;
      }
      const call = res.content.find((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === "tool_use" && b.name === "report_product_research");
      if (call) {
        const parsed = ReportSchema.safeParse(call.input);
        if (!parsed.success) {
          log(`[research] ${product}: unreadable report`);
          return cached;
        }
        const out: ProductResearch = { product, ...clean(parsed.data), searches, model, at: new Date().toISOString() };
        fs.mkdirSync(path.dirname(cacheFile(channel, product)), { recursive: true });
        fs.writeFileSync(cacheFile(channel, product), JSON.stringify(out, null, 1));
        log(`[research] ${product}: ${out.pages.length} official page(s), ${out.specs.length} spec(s), ${searches} search(es), ${usage.in} in / ${usage.out} out tokens (${model})`);
        return out;
      }
      messages.push({ role: "assistant", content: res.content });
      // pause_turn: the server paused a long search turn; sending the history back resumes it.
      if (res.stop_reason !== "pause_turn") messages.push({ role: "user", content: "Call report_product_research now with what you found." });
    }
    log(`[research] ${product}: no report after 5 turns`);
  } catch (err) {
    if (err instanceof Anthropic.AuthenticationError) log(`[research] ANTHROPIC_API_KEY rejected`);
    else if (err instanceof Anthropic.RateLimitError) log(`[research] rate limited; try again later`);
    else if (err instanceof Anthropic.APIError) log(`[research] API error ${err.status}: ${err.message.slice(0, 160)}`);
    else log(`[research] ${product}: ${String((err as Error).message ?? err).slice(0, 160)}`);
  }
  return cached;
}
