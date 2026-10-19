// Builds the studio's live-preview bundle: cards/src/preview/mount.tsx -> web/simple/preview.bundle.js
// (global `ClipForgePreview`). Run by `npm run build:preview` and before `npm run serve`.
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {build} from 'esbuild';

const here = path.dirname(fileURLToPath(import.meta.url));
const shim = path.join(here, 'src', 'preview', 'remotionShim.ts');

// Cards.tsx imports `remotion`; inside the preview it gets the shim (re-exports remotion, adds CardLength).
const cardsUseShim = {
  name: 'cards-use-shim',
  setup(b) {
    b.onResolve({filter: /^remotion$/}, (args) => (args.importer.endsWith(`${path.sep}Cards.tsx`) ? {path: shim} : undefined));
  },
};

await build({
  entryPoints: [path.join(here, 'src', 'preview', 'mount.tsx')],
  outfile: path.join(here, '..', 'web', 'simple', 'preview.bundle.js'),
  bundle: true,
  format: 'iife',
  globalName: 'ClipForgePreview',
  platform: 'browser',
  target: 'es2020',
  jsx: 'automatic',
  minify: true,
  legalComments: 'none',
  define: {'process.env.NODE_ENV': '"production"'},
  // Cards load their font through staticFile(); the server serves cards/public under /cards-static.
  banner: {js: "window.remotion_staticBase='/cards-static';"},
  plugins: [cardsUseShim],
  logLevel: 'warning',
});
console.log('preview bundle built');
