import { after, describe, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "clipforge-factcheck-"));
process.env.FEATURE_SETTINGS_FILE = path.join(tmp, "features.json");
process.env.LLM_SETTINGS_FILE = path.join(tmp, "llm_settings.json");
const { paths } = await import("../src/lib/paths.js");
const F = await import("../src/lib/factcheck/factcheck.js");
const W = await import("../src/lib/research/wiki.js");
const D = await import("../src/lib/formats/documentary.js");
const M = await import("../src/server/routes/make.js");
const P = await import("../src/lib/orchestrator/pipeline.js");
const made: string[] = [];
after(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
  for (const p of made) fs.rmSync(path.join(paths.workspace, p), { recursive: true, force: true });
});

const MALACCA = "The Strait of Malacca is about 900 kilometres long. At its narrowest point, the Phillips Channel in the Singapore Strait, it is only 2.8 kilometres wide. About 94,000 vessels pass through the strait each year.";
const src = [{ id: "s1", kind: "wikipedia", url: "https://en.wikipedia.org/wiki/Strait_of_Malacca", title: "Strait of Malacca (Wikipedia)", text: MALACCA }];

describe("fact checker", () => {
  test("claims: numbers, superlatives and named things; small counts are not claims", () => {
    const c = F.claimsIn("There are three reasons. The strait is 900 kilometres long. It is the busiest strait in Asia. Ships from Port Klang sail daily.");
    assert.deepEqual(c.map((x) => x.sentence), ["The strait is 900 kilometres long.", "It is the busiest strait in Asia.", "Ships from Port Klang sail daily."]);
    assert.deepEqual(F.claimsIn("It is only 5 kilometres wide.")[0].numbers, ["5"], "a small number with a unit is a measure");
    assert.equal(F.claimsIn("The Strait of Malacca links two seas.").length, 1, "names with 'of' count");
  });

  test("a number found in a passage about the same thing is verified, with its source", async () => {
    const r = await F.checkClaims("The Strait of Malacca is 900 kilometres long. The strait was first mapped in 1511.", src);
    assert.equal(r.claims[0].verdict, "supported");
    assert.equal(r.claims[0].url, "https://en.wikipedia.org/wiki/Strait_of_Malacca");
    assert.equal(r.claims[1].verdict, "not_found");
    assert.deepEqual(r.counts, { supported: 1, contradicted: 0, not_found: 1, unchecked: 0 });
  });

  test("the AI cannot verify alone: its quote must be in the source, with the claim's numbers", async () => {
    const liar: import("../src/lib/factcheck/factcheck.js").Judge = async () => ({ verdict: "supported", sourceId: "s1", quote: "the strait was first mapped by explorers in 1511" });
    const r1 = await F.checkClaims("The Strait of Malacca was first mapped in 1511.", src, { judge: liar });
    assert.equal(r1.claims[0].verdict, "not_found", "a quote that is not in the source counts for nothing");
    const honest: import("../src/lib/factcheck/factcheck.js").Judge = async () => ({ verdict: "contradicted", sourceId: "s1", quote: "it is only 2.8 kilometres wide" });
    const r2 = await F.checkClaims("At its narrowest the Strait of Malacca is 5 kilometres wide.", src, { judge: honest });
    assert.equal(r2.claims[0].verdict, "contradicted");
    const noNumber: import("../src/lib/factcheck/factcheck.js").Judge = async () => ({ verdict: "supported", quote: "About 94,000 vessels pass through the strait each year" });
    const r3 = await F.checkClaims("Every year 120000 vessels pass through the Strait of Malacca.", src, { judge: noNumber });
    assert.equal(r3.claims[0].verdict, "not_found", "the quote does not hold the claim's number");
  });

  test("matching numbers do not verify a superlative riding along; rhetoric is not a claim", async () => {
    const r = await F.checkClaims("About 94,000 vessels pass through the Strait of Malacca each year, more than through any other waterway on Earth.", src);
    assert.equal(r.claims[0].verdict, "not_found");
    assert.match(r.claims[0].note!, /numbers are in the source, but "more than through any"/);
    assert.equal(F.claimsIn("For the countries that depend on it, the strait is a door that must never close.").length, 0);
  });

  test("wrong claims always go; unconfirmed ones go when removeUnverified is on", async () => {
    const script = "The Strait of Malacca is 900 kilometres long. It was first mapped in 1511 by the Strait of Malacca survey.\n\nAt its narrowest point the strait is 2.8 kilometres wide.";
    const r = await F.checkClaims(script, src);
    const kept = F.applyCheck(script, r, true);
    assert.equal(kept.text, "The Strait of Malacca is 900 kilometres long.\n\nAt its narrowest point the strait is 2.8 kilometres wide.");
    assert.equal(kept.removed.length, 1);
    assert.equal(F.applyCheck(script, r, false).removed.length, 0);
  });
});

describe("research sources (fake fetch; MediaWiki API parameters)", () => {
  test("Wikipedia search and page text; a broken link is logged and skipped", async () => {
    const urls: string[] = [];
    const fake = (async (u: string, init?: RequestInit) => {
      urls.push(String(u));
      assert.match(String((init?.headers as Record<string, string>)["User-Agent"]), /ClipForge/);
      const url = new URL(String(u));
      if (url.hostname === "bad.example") return new Response("", { status: 404 });
      if (url.searchParams.get("list") === "search") return Response.json({ query: { search: [{ title: "Strait of Malacca" }] } });
      if (url.searchParams.get("prop") === "extracts|info") return Response.json({ query: { pages: { "1": { title: "Strait of Malacca", extract: MALACCA, fullurl: "https://en.wikipedia.org/wiki/Strait_of_Malacca" } } } });
      return new Response("<title>Port page</title><p>Ships wait 2 days.</p>");
    }) as unknown as typeof fetch;
    const logs: string[] = [];
    const s = await W.gatherSources({ topic: "Strait of Malacca", links: ["https://bad.example/x", "https://port.example/a"], notes: "My note: 3 ports.", wikipedia: true, lang: "en", pages: 2, fetch: fake, log: (m) => logs.push(m) });
    assert.deepEqual(s.map((x) => [x.id, x.kind]), [["s1", "notes"], ["s2", "link"], ["s3", "wikipedia"]]);
    assert.ok(logs.some((l) => /could not read https:\/\/bad\.example/.test(l)));
    const search = new URL(urls.find((u) => u.includes("list=search"))!);
    assert.equal(search.searchParams.get("srsearch"), "Strait of Malacca");
    assert.equal(search.searchParams.get("srnamespace"), "0");
    const page = new URL(urls.find((u) => u.includes("extracts"))!);
    assert.equal(page.searchParams.get("explaintext"), "1");
    assert.equal(page.searchParams.get("inprop"), "url");
  });
});

describe("documentary video", () => {
  const fake = (async (u: string) => {
    const url = new URL(String(u));
    if (url.searchParams.get("list") === "search") return Response.json({ query: { search: [{ title: "Strait of Malacca" }] } });
    return Response.json({ query: { pages: { "1": { title: "Strait of Malacca", extract: MALACCA, fullurl: "https://en.wikipedia.org/wiki/Strait_of_Malacca" } } } });
  }) as unknown as typeof fetch;

  test("research -> chapters -> fact check: the invented claim is taken out, the rest keeps its sources", async () => {
    const { project } = M.createMade({ type: "documentary", topic: "zz factcheck strait of malacca", minutes: 3, notes: "" });
    made.push(project);
    assert.equal(JSON.parse(fs.readFileSync(path.join(paths.workspace, project, "project.json"), "utf8")).niche, "documentary");
    const asked: string[] = [];
    const ask: import("../src/lib/formats/documentary.js").Ask = async (_s, user, schema) => {
      asked.push(schema);
      if (schema === "outline") return { title: "The Strait That Moves Asia", chapters: [{ title: "The narrow door", focus: "how narrow it is" }, { title: "The traffic", focus: "ships per year" }] };
      if (schema === "chapter") {
        assert.match(user, /\[s1 Strait of Malacca \(Wikipedia\)\]/);
        return user.includes("Chapter 1") ? { text: "At its narrowest point the Strait of Malacca is only 2.8 kilometres wide. The strait was dug by hand in 1066." } : { text: "About 94,000 vessels pass through the Strait of Malacca each year." };
      }
      return { verdict: "not_found" };
    };
    const r = await D.writeDocumentary(project, { ask, fetch: fake, log: () => {} });
    assert.deepEqual(asked.filter((x) => x !== "judge"), ["outline", "chapter", "chapter"]);
    assert.equal(r.title, "The Strait That Moves Asia");
    assert.deepEqual(r.factcheck.removed, ["The strait was dug by hand in 1066."]);
    const script = fs.readFileSync(path.join(paths.workspace, project, "script.txt"), "utf8");
    assert.doesNotMatch(script, /1066/);
    assert.match(script, /2\.8 kilometres/);
    assert.ok(r.factcheck.claims.filter((c) => c.verdict === "supported").every((c) => c.url === "https://en.wikipedia.org/wiki/Strait_of_Malacca"));
    // The creator edits the script: the edit is checked again against the saved sources.
    const v = await M.makeRoute(["api", "make", project, "script"], "PUT", async () => JSON.stringify({ text: script.trim() + " The strait is 900 kilometres long and was closed in 1999 for " + "repairs to the old lighthouse on the island. ".repeat(6) }));
    assert.equal(v!.status, 200);
    const fc = (v!.body as { report: { factcheck: { claims: { sentence: string; verdict: string }[] } } }).report.factcheck;
    assert.ok(fc.claims.some((c) => /900 kilometres/.test(c.sentence) && c.verdict === "not_found"), "900 is in the source but this sentence also states 1999");
    // Pipeline: own writing step, then the normal voice / footage / edit / render.
    const cfg = P.readConfig(project);
    assert.deepEqual(P.stageSteps("writing", project, cfg), [["documentary", "-p", project, "--write"]]);
    assert.equal(P.stageSteps("visuals", project, cfg)[0][0], "plan");
    assert.deepEqual(P.stageSteps("research", project, cfg), []);
  });

  test("your own script is not rewritten, only checked; no sources and no script is refused", async () => {
    const own = "The Strait of Malacca is about 900 kilometres long. " + "Ships have used it for centuries and still do today. ".repeat(10) + "In 1990 it froze over completely.";
    const { project } = M.createMade({ type: "documentary", topic: "zz factcheck own script", script: own });
    made.push(project);
    const r = await D.writeDocumentary(project, { fetch: fake, log: () => {} });
    assert.equal(r.writer, "own");
    const script = fs.readFileSync(path.join(paths.workspace, project, "script.txt"), "utf8");
    assert.match(script, /^The Strait of Malacca is about 900 kilometres long\./);
    assert.doesNotMatch(script, /froze/);
    assert.throws(() => M.createMade({ type: "documentary", topic: "zz factcheck short", script: "too short" }), /very short/);
  });
});
