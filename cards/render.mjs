// Batch card renderer for ClipForge: one bundle, then every card as ProRes 4444 with alpha.
//   node cards/render.mjs jobs.json   jobs: [{id, props, frames, out}]
// Prints one JSON line per card ({"ok": out} or {"error": ...}). The webpack bundle (a temp dir)
// and half-written files are deleted at the end.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {bundle} from '@remotion/bundler';
import {ensureBrowser, renderMedia, selectComposition} from '@remotion/renderer';

const here = path.dirname(fileURLToPath(import.meta.url));
const jobs = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
let serveUrl = null;
let failed = 0;
try {
  await ensureBrowser();
  serveUrl = await bundle({entryPoint: path.join(here, 'src', 'index.ts'), publicDir: path.join(here, 'public'), outDir: fs.mkdtempSync(path.join(os.tmpdir(), 'cf-cards-'))});
  const concurrency = Math.max(1, Math.min(8, Math.floor(os.cpus().length / 2)));
  for (const job of jobs) {
    const tmp = job.out.replace(/\.mov$/, '.part.mov');
    try {
      const comp = await selectComposition({serveUrl, id: job.id, inputProps: job.props});
      await renderMedia({
        composition: {...comp, durationInFrames: job.frames},
        serveUrl,
        inputProps: job.props,
        codec: 'prores',
        proResProfile: '4444',
        pixelFormat: 'yuva444p10le',
        imageFormat: 'png',
        concurrency,
        outputLocation: tmp,
        logLevel: 'error',
      });
      fs.renameSync(tmp, job.out);
      console.log(JSON.stringify({ok: job.out}));
    } catch (e) {
      failed++;
      fs.rmSync(tmp, {force: true});
      console.log(JSON.stringify({error: String(e?.message ?? e).slice(0, 300), id: job.id}));
    }
  }
} catch (e) {
  console.error(String(e?.stack ?? e));
  process.exitCode = 2;
} finally {
  if (serveUrl && fs.existsSync(serveUrl)) fs.rmSync(serveUrl, {recursive: true, force: true});
}
if (failed) process.exitCode = process.exitCode || 1;
