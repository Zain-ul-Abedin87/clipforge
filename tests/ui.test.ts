import { after, describe, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "clipforge-ui-"));
process.env.LLM_SETTINGS_FILE = path.join(tmp, "llm_settings.json");
const { resolvePage, TAB_PAGES } = await import("../src/server/pages.js");
const { listProjects } = await import("../src/lib/orchestrator/pipeline.js");
const { createVideo } = await import("../src/lib/orchestrator/wizard.js");
const { paths } = await import("../src/lib/paths.js");

const made: string[] = [];
after(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
  for (const p of made) {
    fs.rmSync(path.join(paths.workspace, p), { recursive: true, force: true });
    fs.rmSync(path.join(paths.output, `${p}.mp4`), { force: true });
  }
});

describe("five tabs", () => {
  test("every tab and /app serve an existing page; old addresses redirect (query kept)", () => {
    for (const [p, file] of Object.entries(TAB_PAGES)) {
      assert.deepEqual(resolvePage(p), { file }, p);
      assert.ok(fs.existsSync(path.join(paths.root, "web", file)), file);
    }
    assert.deepEqual(resolvePage("/videos/"), { file: "dashboard.html" });
    assert.deepEqual(resolvePage("/research"), { redirect: "/ideas" });
    assert.deepEqual(resolvePage("/brief", "?ch=survival-pulse"), { redirect: "/channel?ch=survival-pulse" });
    assert.deepEqual(resolvePage("/dashboard"), { redirect: "/videos" });
    assert.deepEqual(resolvePage("/tools"), { redirect: "/settings" });
    assert.equal(resolvePage("/new"), null, "the wizard is served by the page list, not a tab");
  });

  test("the shared header has exactly the five tabs, and every page uses it", () => {
    const js = fs.readFileSync(path.join(paths.root, "web", "full", "full.js"), "utf8");
    const tabs = [...js.matchAll(/\["(\w+)", "(\/\w*)", "([^"]+)"\]/g)].map((m) => m[3]);
    assert.deepEqual(tabs, ["Make", "Ideas", "My videos", "Channel", "Settings"]);
    for (const f of ["home.html", "new.html", "make.html", "research.html", "dashboard.html", "brief.html", "tools.html", "pipeline.html", "chat.html", "simple/index.html"]) {
      const html = fs.readFileSync(path.join(paths.root, "web", f), "utf8");
      assert.match(html, /<header id="top"><\/header>/, f);
      assert.match(html, /header\(\)/, f);
      assert.doesNotMatch(html, /href="#\/create"|>Classic</, `${f} still links the old Create / Classic`);
    }
  });
});

describe("My videos rows", () => {
  test("type, where it opens, edit link; a finished video from the first app is not 'Continue'", () => {
    const { project } = createVideo({ topic: "zz ui ranked lights", products: ["A", "B"], music: { mode: "off" } });
    made.push(project);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(paths.workspace, project, "project.json"), "utf8")).music, { mode: "off" }, "the wizard saves the music choice");
    const classic = "zz-ui-classic-done";
    made.push(classic);
    fs.mkdirSync(path.join(paths.workspace, classic), { recursive: true });
    fs.writeFileSync(path.join(paths.workspace, classic, "project.json"), JSON.stringify({ title: "Own voice-over" }));
    fs.writeFileSync(path.join(paths.workspace, classic, "timeline.json"), "{}");
    fs.mkdirSync(paths.output, { recursive: true });
    fs.writeFileSync(path.join(paths.output, `${classic}.mp4`), "x");
    const rows = listProjects();
    const r = rows.find((x) => x.name === project)!;
    assert.deepEqual([r.type, r.open, r.edit], ["ranked", `/new?v=${project}`, null]);
    assert.match(r.current, /^next: /);
    const c = rows.find((x) => x.name === classic)!;
    assert.deepEqual([c.type, c.open, c.edit, c.current], ["classic", `/app#/project/${classic}`, `/app#/project/${classic}`, "complete"]);
  });
});
