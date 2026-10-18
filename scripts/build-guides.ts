/**
 * Renders the picture guides (src/telegram/guides.ts) to PNG files in public/guide/.
 * Run after changing guide texts: npm run build-guides   (images are committed; CI does not need sharp)
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import sharp from 'sharp';
import { guidesFor, type GuideCard, type GuideUi } from '../src/telegram/guides.ts';

const W = 1280;
const H = 960;
const FONT = 'Segoe UI, Arial, Helvetica, sans-serif';

const x = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function text(tx: number, ty: number, s: string, size: number, opts: { weight?: number; color?: string; anchor?: string } = {}): string {
  return `<text x="${tx}" y="${ty}" font-family="${FONT}" font-size="${size}" font-weight="${opts.weight ?? 400}" fill="${opts.color ?? '#1d2433'}" text-anchor="${opts.anchor ?? 'start'}">${x(s)}</text>`;
}

/** Simplified Sparrow window with the relevant control highlighted. */
function mockWindow(ui: GuideUi, accent: string, top: number): string {
  const left = 80;
  const width = W - 160;
  const height = H - top - 60;
  const parts: string[] = [];
  parts.push(`<rect x="${left}" y="${top}" width="${width}" height="${height}" rx="14" fill="#ffffff" stroke="#d5dae5" stroke-width="2"/>`);
  parts.push(`<rect x="${left}" y="${top}" width="${width}" height="44" rx="14" fill="#eef1f6"/>`);
  parts.push(`<rect x="${left}" y="${top + 30}" width="${width}" height="14" fill="#eef1f6"/>`);
  parts.push(text(left + 20, top + 30, 'Sparrow', 20, { weight: 600, color: '#5b6478' }));
  // menu bar
  const menus = ['File', 'View', 'Tools', 'Help'];
  let mx = left + 20;
  const menuY = top + 76;
  const menuX: Record<string, number> = {};
  for (const m of menus) {
    menuX[m] = mx;
    const active = ui.menuPath?.[0] === m;
    if (active) parts.push(`<rect x="${mx - 10}" y="${menuY - 26}" width="${m.length * 13 + 22}" height="36" rx="6" fill="${accent}"/>`);
    parts.push(text(mx, menuY, m, 22, { color: active ? '#ffffff' : '#1d2433', weight: active ? 700 : 400 }));
    mx += m.length * 13 + 40;
  }
  parts.push(`<line x1="${left}" y1="${top + 92}" x2="${left + width}" y2="${top + 92}" stroke="#e1e5ee" stroke-width="2"/>`);

  const bodyTop = top + 92;
  const hasSidebar = !!ui.sidebar || (!ui.menuPath && (ui.fields || ui.buttons));
  let contentLeft = left + 30;
  if (hasSidebar) {
    const items = ['Transactions', 'Send', 'Receive', 'Addresses', 'UTXOs', 'Settings'];
    parts.push(`<rect x="${left}" y="${bodyTop}" width="210" height="${height - 92}" fill="#3d4a63"/>`);
    items.forEach((it, i) => {
      const iy = bodyTop + 28 + i * 52;
      if (iy > top + height - 20) return;
      if (ui.sidebar === it) parts.push(`<rect x="${left}" y="${iy - 30}" width="210" height="46" fill="${accent}"/>`);
      parts.push(text(left + 105, iy, it, 20, { color: '#ffffff', anchor: 'middle', weight: ui.sidebar === it ? 700 : 400 }));
    });
    contentLeft = left + 250;
  }

  // dropdown chain for menu paths
  if (ui.menuPath && ui.menuPath.length > 1) {
    let dx = menuX[ui.menuPath[0]!]! - 10;
    let dy = bodyTop + 4;
    for (let level = 1; level < ui.menuPath.length; level++) {
      const label = ui.menuPath[level]!;
      const boxW = Math.max(260, label.length * 14 + 60);
      parts.push(`<rect x="${dx}" y="${dy}" width="${boxW}" height="132" rx="8" fill="#ffffff" stroke="#c9cfdb" stroke-width="2"/>`);
      parts.push(text(dx + 20, dy + 38, '…', 20, { color: '#9aa3b5' }));
      parts.push(`<rect x="${dx + 6}" y="${dy + 52}" width="${boxW - 12}" height="40" rx="6" fill="${accent}"/>`);
      parts.push(text(dx + 20, dy + 80, label, 22, { color: '#ffffff', weight: 700 }));
      parts.push(text(dx + 20, dy + 120, '…', 20, { color: '#9aa3b5' }));
      dx += boxW + 16;
      dy += 52;
    }
  }

  let cy = bodyTop + 60;
  for (const f of ui.fields ?? []) {
    parts.push(text(contentLeft, cy, f.label, 22, { color: '#5b6478' }));
    parts.push(
      `<rect x="${contentLeft + 240}" y="${cy - 30}" width="${Math.min(560, left + width - contentLeft - 280)}" height="44" rx="6" fill="#f7f8fb" stroke="${accent}" stroke-width="3"/>`,
    );
    parts.push(text(contentLeft + 256, cy, f.value, 22, { color: '#1d2433' }));
    cy += 70;
  }
  let bx = contentLeft;
  (ui.buttons ?? []).forEach((btn, i) => {
    const bw = btn.length * 12 + 48;
    if (bx + bw > left + width - 20) {
      bx = contentLeft;
      cy += 70;
    }
    const hi = i === 0;
    parts.push(
      `<rect x="${bx}" y="${cy - 30}" width="${bw}" height="48" rx="8" fill="${hi ? accent : '#eef1f6'}" stroke="${hi ? accent : '#c9cfdb'}" stroke-width="2"/>`,
    );
    parts.push(text(bx + bw / 2, cy + 2, btn, 21, { color: hi ? '#ffffff' : '#1d2433', anchor: 'middle', weight: hi ? 700 : 500 }));
    bx += bw + 20;
  });
  return parts.join('\n');
}

function card(guideName: string, accent: string, c: GuideCard, index: number, total: number): string {
  const parts: string[] = [];
  parts.push(`<rect width="${W}" height="${H}" fill="#f4f6fb"/>`);
  parts.push(`<rect width="${W}" height="88" fill="${accent}"/>`);
  parts.push(text(60, 58, `BTC TREUHAND · ${guideName}`, 30, { color: '#ffffff', weight: 700 }));
  parts.push(text(W - 60, 58, `Schritt ${index} von ${total}`, 28, { color: '#ffffff', anchor: 'end', weight: 600 }));
  parts.push(`<circle cx="120" cy="190" r="56" fill="${accent}"/>`);
  parts.push(text(120, 210, String(index), 56, { color: '#ffffff', anchor: 'middle', weight: 800 }));
  parts.push(text(210, 205, c.title, 44, { weight: 800 }));
  c.lines.forEach((l, i) => parts.push(text(80, 300 + i * 44, l, 30, { color: '#2c3446' })));
  if (c.ui) parts.push(mockWindow(c.ui, accent, 300 + c.lines.length * 44 + 20));
  else {
    // no UI mock: large hint box
    const top = 300 + c.lines.length * 44 + 40;
    parts.push(
      `<rect x="80" y="${top}" width="${W - 160}" height="${H - top - 60}" rx="16" fill="#ffffff" stroke="${accent}" stroke-width="3" stroke-dasharray="10 8"/>`,
    );
    parts.push(
      text(W / 2, top + (H - top - 60) / 2 + 12, 'Tipp: In jedem Schritt zeigt dir der Bot den passenden Button.', 28, {
        color: '#5b6478',
        anchor: 'middle',
      }),
    );
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">${parts.join('\n')}</svg>`;
}

for (const network of ['signet', 'mainnet'] as const) {
  mkdirSync(`public/guide/${network}`, { recursive: true });
  for (const g of guidesFor(network)) {
    for (let i = 0; i < g.cards.length; i++) {
      const svg = card(g.name, g.color, g.cards[i]!, i + 1, g.cards.length);
      const png = await sharp(Buffer.from(svg)).png({ compressionLevel: 9 }).toBuffer();
      const file = `public/guide/${network}/${g.id}-${i + 1}.png`;
      writeFileSync(file, png);
      console.log(file, `${Math.round(png.length / 1024)} KB`);
    }
  }
}
