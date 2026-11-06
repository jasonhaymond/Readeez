// scripts/make-icons.mjs
// Generates every icon the app uses from the one master drawing, assets/logo.svg, and writes them into assets/.
// A developer runs it by hand after changing the logo, then commits the results. It isn't part of a normal build,
// and it touches nothing outside assets/.
//
// It draws each icon in a headless Chromium browser (Playwright), which is the simplest accurate way to turn an
// SVG into a PNG. Playwright is deliberately not a project dependency, because it's large and this rarely runs:
//   npm install --no-save playwright && npx playwright install chromium && node scripts/make-icons.mjs
// To use a copy of Playwright installed elsewhere, give its folder as the argument:
//   node scripts/make-icons.mjs /path/to/node_modules/playwright

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ASSETS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'assets');
const master = readFileSync(path.join(ASSETS, 'logo.svg'), 'utf8');

// The logo's page and ribbon colours, plus the amber that stands in for cream on the light splash screen.
const AMBER = '#9A5B13';
const CREAM = '#FFF8EC';
const GOLD = '#E8B25E';

/**
 * Finds one part of the master drawing.
 * In: the part's id, e.g. 'ribbon'. Out: its outline data. Throws if the part is missing, so a renamed id
 * stops the script instead of producing a blank icon.
 */
function outline(id) {
  // Matches the element's whole tag, then captures its d="..." value. Example: <path id="ribbon" d="M3 1z"/>
  const match = master.match(new RegExp(`id="${id}"[^>]*\\sd="([^"]+)"`));
  if (!match) throw new Error(`assets/logo.svg has no part with the id "${id}"`);
  return match[1];
}

const LEFT = outline('left-page');
const RIGHT = outline('right-page');
const RIBBON = outline('ribbon');

/**
 * Draws the book.
 * In: page colour, ribbon colour, and a scale around the drawing's centre (1 is the master's size).
 * Out: SVG markup.
 */
const book = (pages, ribbon, scale) => `
  <g transform="translate(256 256) scale(${scale}) translate(-256 -256)">
    <path d="${LEFT}" fill="${pages}"/>
    <path d="${RIGHT}" fill="${pages}" opacity=".84"/>
    <path d="${RIBBON}" fill="${ribbon}"/>
  </g>`;

/**
 * The themed-icon version. Android recolours it, using only how see-through each pixel is, so colour can't set the
 * ribbon apart. A transparent gap around the ribbon does that job instead.
 * In: scale. Out: SVG markup.
 */
const singleColourBook = (scale) => `
  <defs><mask id="gap">
    <rect width="512" height="512" fill="white"/>
    <path d="${RIBBON}" fill="black" stroke="black" stroke-width="20"/>
  </mask></defs>
  <g transform="translate(256 256) scale(${scale}) translate(-256 -256)">
    <g mask="url(#gap)">
      <path d="${LEFT}" fill="white"/>
      <path d="${RIGHT}" fill="white" opacity=".84"/>
    </g>
    <path d="${RIBBON}" fill="white"/>
  </g>`;

/** Wraps drawing parts into a complete 512-unit SVG. In: the parts' markup. Out: a full SVG document. */
const svg = (inner) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="100%" height="100%">${inner}</svg>`;

// Just the gradient, with square corners, for Android's adaptive icon background and for icon.png.
const GRADIENT = `<rect width="512" height="512" fill="url(#tile-gradient)"/>`;
const GRADIENT_DEFS = master.match(/<defs>[\s\S]*?<\/defs>/)[0];

// Android crops launcher icons to whatever shape the phone uses and only promises to show the middle. At 0.69
// the whole book, ribbon included, stays inside that safe circle.
const ADAPTIVE_SCALE = 0.69;
// The splash screen can also be cropped to a circle, so the book stays inside one here too.
const SPLASH_SCALE = 0.9;

// Each file: its name, its pixel size, and its drawing. Files with no background are transparent.
const FILES = [
  // The whole logo with its rounded corners: used on the app's screens and in the browser tab.
  ['logo-mark.png', 256, master],
  ['favicon.png', 48, master],
  // Square corners, because the store and launchers apply their own shape.
  ['icon.png', 1024, svg(`${GRADIENT_DEFS}${GRADIENT}${book(CREAM, GOLD, 1)}`)],
  // Android's adaptive icon: a background layer, a book layer on top, and the themed-icon version.
  ['android-icon-background.png', 512, svg(`${GRADIENT_DEFS}${GRADIENT}`)],
  ['android-icon-foreground.png', 1024, svg(book(CREAM, GOLD, ADAPTIVE_SCALE))],
  ['android-icon-monochrome.png', 1024, svg(singleColourBook(ADAPTIVE_SCALE))],
  // The splash screen, which has separate light and dark backgrounds.
  ['splash-icon.png', 512, svg(book(AMBER, GOLD, SPLASH_SCALE))],
  ['splash-icon-dark.png', 512, svg(book(CREAM, GOLD, SPLASH_SCALE))],
];

const require = createRequire(import.meta.url);
const { chromium } = require(process.argv[2] ?? 'playwright');
const browser = await chromium.launch();

// One browser page per icon, sized to exactly the output size, and captured with a transparent background.
for (const [name, size, markup] of FILES) {
  const page = await browser.newPage({ viewport: { width: size, height: size } });
  // The master has its own fixed size, so it's stretched to fill the page here.
  const sized = markup.replace('width="512" height="512"', 'width="100%" height="100%"');
  await page.setContent(`<!doctype html><html><body style="margin:0;background:transparent;height:100vh">${sized}</body></html>`);
  await page.screenshot({ path: path.join(ASSETS, name), omitBackground: true });
  await page.close();
  console.log(`wrote assets/${name}`);
}
await browser.close();
