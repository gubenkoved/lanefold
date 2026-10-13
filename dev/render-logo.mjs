// Renders the logo's PNG sizes from its SVGs with Chromium (the Marketplace icon is one of them).
//   node dev/render-logo.mjs            → media/logo/lanefold-<size>.png
//   node dev/render-logo.mjs <sheet.png> → also a preview sheet of the sizes and the panel glyph,
//                                          on dark, light and Marketplace-banner backgrounds
import { chromium } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const LOGO = 'media/logo';
const SIZES = [16, 24, 32, 48, 64, 128, 256, 512, 1024];
/** At these sizes and below, the bolder variant reads better. */
const SMALL = 32;

const svg = (name) => readFileSync(join(LOGO, name), 'utf8');
const full = svg('lanefold.svg');
const small = svg('lanefold-small.svg');
const glyph = readFileSync('media/lanefold.svg', 'utf8');

/** An SVG as an <img>: each one keeps its own gradient ids. */
const img = (source, size) =>
  `<img width="${size}" height="${size}" src="data:image/svg+xml;base64,${Buffer.from(source).toString('base64')}">`;

const browser = await chromium.launch();
try {
  const page = await browser.newPage({ deviceScaleFactor: 1 });
  for (const size of SIZES) {
    await page.setViewportSize({ width: size, height: size });
    await page.setContent(
      `<html><body style="margin:0;background:transparent">${img(size <= SMALL ? small : full, size)}</body></html>`,
    );
    await page.screenshot({ path: join(LOGO, `lanefold-${size}.png`), omitBackground: true });
  }

  const sheet = process.argv[2];
  if (sheet) {
    const row = (background, color) => `
      <div style="display:flex;align-items:flex-end;gap:24px;padding:24px;background:${background};color:${color}">
        ${SIZES.filter((size) => size <= 256)
          .map(
            (size) =>
              `<figure style="margin:0;text-align:center;font:12px system-ui">${img(size <= SMALL ? small : full, size)}<figcaption>${size}</figcaption></figure>`,
          )
          .join('')}
        <figure style="margin:0 0 0 24px;text-align:center;font:12px system-ui">
          <span style="display:inline-flex;gap:12px;color:${color}">
            ${img(glyph.replaceAll('currentColor', color), 16)}${img(glyph.replaceAll('currentColor', color), 24)}
          </span><figcaption>glyph</figcaption></figure>
      </div>`;
    await page.setViewportSize({ width: 1100, height: 700 });
    await page.setContent(
      `<html><body style="margin:0">${row('#1e1e1e', '#cccccc')}${row('#f3f3f3', '#424242')}${row('#1e2241', '#e6e6e6')}</body></html>`,
    );
    await page.screenshot({ path: sheet, fullPage: true });
  }
} finally {
  await browser.close();
}
