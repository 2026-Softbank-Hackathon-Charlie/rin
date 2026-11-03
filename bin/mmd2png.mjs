// Renders a Mermaid file to PNG with the image's Chromium and the vendored mermaid.min.js, without puppeteer.
//   mmd2png <in.mmd> <out.png> [--scale 2]
// Pass 1 lets Chromium run Mermaid and dumps the resulting DOM. Pass 2 screenshots that SVG at its own size.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const MERMAID_JS = process.env.MERMAID_JS ?? '/opt/mermaid/mermaid.min.js';
const CHROMIUM = process.env.CHROMIUM ?? 'chromium';
const PAD = 16;
const FONT = '"Noto Sans CJK KR", sans-serif';

/** Page that renders `source` into #out, or puts Mermaid's error message there. */
export function renderPage(source, mermaidUrl) {
  // JSON with "<" escaped keeps any text in the diagram from closing the script element.
  const json = (v) => JSON.stringify(v).replace(/</g, '\\u003c');
  return `<!doctype html><html><head><meta charset="utf-8">
<style>body{margin:0;background:#fff;font-family:${FONT}}</style>
<script src="${mermaidUrl}"></script></head><body><div id="out"></div><script>
(async () => {
  const out = document.getElementById('out');
  try {
    mermaid.initialize({ startOnLoad: false, fontFamily: ${json(FONT)} });
    out.innerHTML = (await mermaid.render('diagram', ${json(source)})).svg;
  } catch (err) {
    const pre = document.createElement('pre');
    pre.id = 'mmd' + '-error';
    pre.textContent = String((err && err.message) || err);
    out.replaceChildren(pre);
  }
})();
</script></body></html>`;
}

const unescape = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');

/** Finds the rendered SVG and its size in the dumped DOM, or Mermaid's error message. */
export function extractSvg(dom) {
  const from = dom.indexOf('<div id="out">');
  if (from < 0) return { error: 'Chromium did not return the page' };
  const err = /<pre id="mmd-error">([\s\S]*?)<\/pre>/.exec(dom.slice(from));
  if (err) return { error: unescape(err[1]) };
  const start = dom.indexOf('<svg', from);
  const end = dom.lastIndexOf('</svg>');
  if (start < 0 || end < start) return { error: 'Mermaid did not produce an SVG (rendering may have timed out)' };
  const svg = dom.slice(start, end + '</svg>'.length);
  const open = svg.slice(0, svg.indexOf('>'));
  const box = /viewBox="\s*[-\d.e]+[\s,]+[-\d.e]+[\s,]+([\d.e]+)[\s,]+([\d.e]+)\s*"/.exec(open);
  if (!box) return { error: 'the SVG has no viewBox' };
  return { svg, width: Math.ceil(Number(box[1])), height: Math.ceil(Number(box[2])) };
}

function chromium(args) {
  return execFileSync(CHROMIUM, ['--headless', '--disable-gpu', '--hide-scrollbars', ...args], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 60_000,
  });
}

export function render(input, output, scale = 2) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mmd2png-'));
  try {
    const page = path.join(tmp, 'render.html');
    fs.writeFileSync(page, renderPage(fs.readFileSync(input, 'utf8'), pathToFileURL(MERMAID_JS).href));
    const dom = chromium(['--window-size=2000,2000', '--virtual-time-budget=15000', '--dump-dom', pathToFileURL(page).href]);
    const found = extractSvg(dom);
    if (found.error) throw new Error(`Mermaid: ${found.error}`);

    const shot = path.join(tmp, 'shot.html');
    fs.writeFileSync(
      shot,
      `<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;background:#fff;font-family:${FONT}}body{padding:${PAD}px}svg{display:block}</style></head><body>${found.svg}</body></html>`,
    );
    const target = path.resolve(output);
    chromium([
      `--window-size=${found.width + 2 * PAD},${found.height + 2 * PAD}`,
      `--force-device-scale-factor=${scale}`,
      `--screenshot=${target}`,
      pathToFileURL(shot).href,
    ]);
    if (!fs.existsSync(target)) throw new Error('Chromium did not write the PNG');
    return { width: (found.width + 2 * PAD) * scale, height: (found.height + 2 * PAD) * scale };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

function main(argv) {
  const args = argv.slice(2);
  const at = args.indexOf('--scale');
  const scale = at >= 0 ? Number(args.splice(at, 2)[1]) : 2;
  const [input, output] = args;
  if (!input || !output || !(scale > 0)) {
    console.error('usage: mmd2png <in.mmd> <out.png> [--scale 2]');
    process.exit(2);
  }
  try {
    const size = render(input, output, scale);
    console.log(`wrote ${output} (${size.width}x${size.height})`);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) main(process.argv);
