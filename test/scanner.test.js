'use strict';
/**
 * The scanner's vision code, checked against synthetic table photos:
 * noisy felt, chips with edge spots and inlays, euro/pound coins drawn to scale, banknotes.
 * (Synthetic images only — real photos add glare, shadows and perspective.)
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const CV = require('../public/js/scanner-cv.js');

let seed = 7;
const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };

function canvas(w, h, bg) {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) { data[i * 4] = bg[0]; data[i * 4 + 1] = bg[1]; data[i * 4 + 2] = bg[2]; data[i * 4 + 3] = 255; }
  return { data, width: w, height: h };
}
function blend(img, x, y, col, a) {
  if (x < 0 || y < 0 || x >= img.width || y >= img.height || a <= 0) return;
  const i = (y * img.width + x) * 4;
  for (let k = 0; k < 3; k++) img.data[i + k] = img.data[i + k] * (1 - a) + col[k] * a;
}
function disc(img, cx, cy, r, col) {
  for (let y = Math.floor(cy - r - 1); y <= cy + r + 1; y++) for (let x = Math.floor(cx - r - 1); x <= cx + r + 1; x++) {
    const d = Math.hypot(x - cx, y - cy);
    blend(img, x, y, col, Math.max(0, Math.min(1, r - d + 0.5)));
  }
}
function chip(img, cx, cy, r, col) {
  disc(img, cx + 2, cy + 3, r, [10, 40, 28]); // soft shadow
  disc(img, cx, cy, r, col);
  for (let k = 0; k < 6; k++) { // white edge spots
    const a = (k / 6) * Math.PI * 2;
    disc(img, cx + Math.cos(a) * r * 0.88, cy + Math.sin(a) * r * 0.88, r * 0.1, [235, 235, 230]);
  }
  disc(img, cx, cy, r * 0.55, col.map((v) => Math.min(255, v + 28))); // inlay ring
  disc(img, cx, cy, r * 0.5, col);
}
function rect(img, cx, cy, len, wid, ang, col) {
  const ca = Math.cos(ang), sa = Math.sin(ang);
  const R = Math.hypot(len, wid) / 2 + 2;
  for (let y = Math.floor(cy - R); y <= cy + R; y++) for (let x = Math.floor(cx - R); x <= cx + R; x++) {
    const dx = x - cx, dy = y - cy;
    const u = dx * ca + dy * sa, v = -dx * sa + dy * ca;
    if (Math.abs(u) <= len / 2 && Math.abs(v) <= wid / 2) {
      // a little print: lighter band and darker corner block
      const shade = Math.abs(u) < len * 0.12 ? 1.15 : u > len * 0.3 && v < 0 ? 0.85 : 1;
      blend(img, x, y, col.map((c) => Math.min(255, c * shade)), 1);
    }
  }
}
function noise(img, amp) {
  for (let i = 0; i < img.data.length; i += 4) {
    const nz = (rnd() - 0.5) * 2 * amp;
    img.data[i] += nz; img.data[i + 1] += nz; img.data[i + 2] += nz;
  }
}

const FELT = [22, 104, 72];
const match = (found, truth, tol) => truth.map((t) => found.find((f) => Math.hypot(f.x - t.x, f.y - t.y) < tol));

test('finds chips on felt and groups them by colour', () => {
  const img = canvas(640, 480, FELT);
  const RED = [196, 38, 44], BLUE = [36, 70, 170], BLACK = [28, 28, 30], WHITE = [236, 232, 222], GREEN = [40, 150, 60];
  const truth = [
    { x: 90, y: 90, r: 46, c: RED }, { x: 200, y: 100, r: 46, c: RED }, { x: 320, y: 95, r: 47, c: RED },
    { x: 450, y: 100, r: 46, c: BLUE }, { x: 560, y: 110, r: 45, c: BLUE },
    { x: 110, y: 240, r: 47, c: BLACK }, { x: 240, y: 250, r: 46, c: WHITE }, { x: 360, y: 245, r: 46, c: WHITE },
    { x: 500, y: 260, r: 48, c: GREEN }, { x: 180, y: 390, r: 46, c: GREEN }, { x: 330, y: 385, r: 46, c: BLACK },
  ];
  for (const t of truth) chip(img, t.x, t.y, t.r, t.c);
  noise(img, 9);

  const circles = CV.measureCircles(img, CV.detectCircles(img));
  const hits = match(circles, truth, 6);
  assert.equal(hits.filter(Boolean).length, truth.length, 'every chip is found (incl. green chip on green felt)');
  assert.equal(circles.length, truth.length, 'no phantom chips');
  hits.forEach((hit, i) => assert.ok(Math.abs(hit.r - truth[i].r) <= 4, `radius of chip ${i}: ${hit.r} vs ${truth[i].r}`));

  const groups = CV.classifyChips(circles);
  const counts = Object.fromEntries(groups.map((g) => [g.name, g.items.length]));
  assert.deepEqual(counts, { red: 3, blue: 2, black: 2, white: 2, green: 2 });
});

test('ignores a busy, empty table', () => {
  const img = canvas(480, 360, [120, 84, 52]);
  for (let k = 0; k < 60; k++) rect(img, rnd() * 480, rnd() * 360, 200, 3, 0.05, [100 + rnd() * 30, 70, 44]); // wood grain
  noise(img, 12);
  assert.equal(CV.detectCircles(img).length, 0);
});

function coinScene(currency, ids, scalePxPerMm) {
  const cur = CV.CURRENCIES[currency];
  const img = canvas(640, 480, [58, 62, 70]);
  const METAL = { copper: [178, 106, 62], gold: [212, 176, 84], silver: [186, 188, 186] };
  const truth = [];
  ids.forEach((id, i) => {
    const dn = cur.coins.find((c) => c.id === id);
    const r = (dn.d / 2) * scalePxPerMm;
    const x = 90 + (i % 5) * 115, y = 110 + Math.floor(i / 5) * 130;
    disc(img, x + 1, y + 2, r, [30, 32, 38]);
    if (dn.metal === 'bi-gold-ring') { disc(img, x, y, r, METAL.gold); disc(img, x, y, r * 0.66, METAL.silver); }
    else if (dn.metal === 'bi-silver-ring') { disc(img, x, y, r, METAL.silver); disc(img, x, y, r * 0.66, METAL.gold); }
    else { disc(img, x, y, r, METAL[dn.metal]); disc(img, x, y, r * 0.86, METAL[dn.metal].map((v) => v - 14)); }
    truth.push({ x, y, r, id });
  });
  noise(img, 7);
  return { img, truth };
}

test('euro coins: denominations from relative size and metal colour', () => {
  const ids = ['1c', '2c', '5c', '10c', '20c', '50c', '1e', '2e', '20c', '1e'];
  const { img, truth } = coinScene('EUR', ids, 3.6);
  const circles = CV.measureCircles(img, CV.detectCircles(img));
  const hits = match(circles, truth, 5);
  assert.equal(hits.filter(Boolean).length, truth.length, 'all coins found');
  const info = CV.classifyCoins(circles, 'EUR');
  const got = hits.map((h) => h.denom.id);
  assert.deepEqual(got, ids);
  assert.ok(Math.abs(1 / info.mmPerPx - 3.6) < 0.2, `scale recovered: ${(1 / info.mmPerPx).toFixed(2)} px/mm`);
  const total = hits.reduce((s, h) => s + h.denom.value, 0);
  assert.equal(Math.round(total * 100), 508);
});

test('pound coins', () => {
  const ids = ['1p', '2p', '5p', '10p', '20p', '50p', '1l', '2l'];
  const { img, truth } = coinScene('GBP', ids, 3.3);
  const circles = CV.measureCircles(img, CV.detectCircles(img));
  const hits = match(circles, truth, 5);
  assert.equal(hits.filter(Boolean).length, truth.length, 'all coins found');
  CV.classifyCoins(circles, 'GBP');
  assert.deepEqual(hits.map((h) => h.denom.id), ids);
});

test('a single coin is flagged as ambiguous instead of guessed silently', () => {
  const { img } = coinScene('EUR', ['20c'], 3.6);
  const circles = CV.measureCircles(img, CV.detectCircles(img));
  assert.equal(circles.length, 1);
  const info = CV.classifyCoins(circles, 'EUR');
  assert.equal(info.ambiguous, true);
  assert.equal(circles[0].denom.metal, 'gold');
});

test('banknotes: rotated rectangles classified by colour, coins left alone', () => {
  const img = canvas(640, 480, FELT);
  rect(img, 160, 120, 220, 116, 0.12, [70, 110, 190]);   // €20 blue
  rect(img, 460, 130, 230, 127, -0.2, [214, 140, 70]);   // €50 orange
  rect(img, 170, 350, 200, 103, 1.45, [158, 160, 150]);  // €5 grey
  disc(img, 480, 370, 42, [212, 176, 84]);
  disc(img, 480, 370, 28, [186, 188, 186]);              // €1
  noise(img, 8);
  const circles = CV.measureCircles(img, CV.detectCircles(img));
  assert.equal(circles.length, 1);
  const notes = CV.classifyNotes(CV.detectNotes(img, circles), 'EUR', null);
  assert.equal(notes.length, 3);
  const labels = notes.map((n) => n.denom.label).sort();
  assert.deepEqual(labels, ['€20', '€5', '€50']);
  const blue = notes.find((n) => n.denom.label === '€20');
  assert.ok(Math.hypot(blue.cx - 160, blue.cy - 120) < 10);
  assert.ok(Math.abs(blue.w - 220) < 16 && Math.abs(blue.h - 116) < 14, `size ${blue.w.toFixed(0)}×${blue.h.toFixed(0)}`);
});

test('pound notes by colour', () => {
  const img = canvas(640, 480, [60, 62, 66]);
  rect(img, 170, 120, 240, 125, 0.05, [60, 170, 165]);   // £5 teal
  rect(img, 460, 130, 250, 131, -0.1, [150, 90, 180]);   // £20 purple
  rect(img, 320, 350, 255, 134, 0.3, [196, 60, 66]);     // £50 red
  noise(img, 8);
  const notes = CV.classifyNotes(CV.detectNotes(img, []), 'GBP', null);
  assert.deepEqual(notes.map((n) => n.denom.label).sort(), ['£20', '£5', '£50']);
});
