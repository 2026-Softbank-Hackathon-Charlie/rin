import assert from 'node:assert/strict';
import { test } from 'node:test';
// @ts-expect-error plain .mjs script without type declarations
import { extractSvg, renderPage } from '../bin/mmd2png.mjs';

test('diagram text cannot close the script element of the render page', () => {
  const page: string = renderPage('graph LR\n  A["</script><script>alert(1)</script>"] --> B', 'file:///opt/mermaid/mermaid.min.js');
  assert.equal(page.match(/<\/script>/g)?.length, 2); // the mermaid.min.js tag and the page's own script
  assert.match(page, /\\u003c\/script>/);
});

test('the rendered SVG and its size come from the dumped DOM', () => {
  const dom =
    '<html><body><div id="out"><svg id="diagram" width="100%" viewBox="-8 -8 640.5 212" style="max-width: 640.5px;">' +
    '<foreignObject><div>결제</div></foreignObject></svg></div><script>const x = 1;</script></body></html>';
  const got = extractSvg(dom);
  assert.equal(got.width, 641);
  assert.equal(got.height, 212);
  assert.ok(got.svg.startsWith('<svg id="diagram"') && got.svg.endsWith('</svg>'));
});

test("Mermaid's error message is reported, not taken from the page script", () => {
  // A page that never ran: its script mentions the error element but must not count as an error.
  const page: string = renderPage('graph LR\n A -->', 'file:///x.js');
  assert.deepEqual(extractSvg(page), {
    error: 'Mermaid did not produce an SVG (rendering may have timed out)',
  });
  const dom = '<div id="out"><pre id="mmd-error">Parse error on line 2:\n A --&gt;</pre></div>';
  assert.deepEqual(extractSvg(dom), { error: 'Parse error on line 2:\n A -->' });
});
