/**
 * Scanner computer vision — runs entirely on the phone, no images leave the device.
 *
 *   detectCircles()  Hough-gradient circle transform on colour edges → chips and coins
 *   detectNotes()    background segmentation + oriented rectangles → banknotes
 *   classify*()      colour-histogram clustering (chips), size + metal colour (coins), colour + size (notes)
 *
 * Works on plain { data: RGBA bytes, width, height } objects, so it can be tested in Node.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.ScannerCV = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /* ------------------------------------------------------------ colour */

  function rgbToHsv(r, g, b) {
    r /= 255; g /= 255; b /= 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
    let h = 0;
    if (d > 1e-6) {
      if (max === r) h = ((g - b) / d) % 6;
      else if (max === g) h = (b - r) / d + 2;
      else h = (r - g) / d + 4;
      h *= 60;
      if (h < 0) h += 360;
    }
    return { h, s: max <= 0 ? 0 : d / max, v: max };
  }

  function colorName(h, s, v) {
    if (v < 0.2) return 'black';
    if (s < 0.2) return v > 0.72 ? 'white' : v < 0.38 ? 'black' : 'gray';
    if (v < 0.3 && s < 0.5) return 'black';
    if (h < 14 || h >= 342) return 'red';
    if (h < 40) return v < 0.5 ? 'brown' : 'orange';
    if (h < 68) return 'yellow';
    if (h < 165) return 'green';
    if (h < 195) return 'teal';
    if (h < 255) return 'blue';
    if (h < 292) return 'purple';
    return 'pink';
  }

  function makeColor(r, g, b) {
    const hsv = rgbToHsv(r, g, b);
    const hex = '#' + [r, g, b].map((x) => Math.max(0, Math.min(255, Math.round(x))).toString(16).padStart(2, '0')).join('');
    return { r, g, b, h: hsv.h, s: hsv.s, v: hsv.v, hex, name: colorName(hsv.h, hsv.s, hsv.v) };
  }

  /**
   * Dominant colour of a set of pixels via a coarse hue/lightness histogram:
   * the fullest bin (plus its hue neighbours) wins, so edge spots, glare and
   * printed inlays do not drag the result toward a muddy average.
   */
  function Histogram() {
    const BINS = 21; // 18 hue bins + black, gray, white
    const count = new Float64Array(BINS), sr = new Float64Array(BINS), sg = new Float64Array(BINS), sb = new Float64Array(BINS);
    let total = 0;
    return {
      add(r, g, b) {
        const { h, s, v } = rgbToHsv(r, g, b);
        let bin;
        if (v < 0.18) bin = 18;
        else if (s < 0.2) bin = v > 0.7 ? 20 : 19;
        else bin = Math.min(17, Math.floor(h / 20));
        count[bin]++; sr[bin] += r; sg[bin] += g; sb[bin] += b; total++;
      },
      dominant() {
        if (!total) return makeColor(128, 128, 128);
        let best = 0;
        for (let i = 1; i < BINS; i++) if (count[i] > count[best]) best = i;
        let c = count[best], r = sr[best], g = sg[best], b = sb[best];
        if (best < 18) {
          for (const nb of [(best + 17) % 18, (best + 1) % 18]) { c += count[nb]; r += sr[nb]; g += sg[nb]; b += sb[nb]; }
        }
        const col = makeColor(r / c, g / c, b / c);
        col.share = c / total;
        return col;
      },
    };
  }

  function annulusColor(img, cx, cy, r0, r1) {
    const { data, width: w, height: h } = img;
    const hist = Histogram();
    const step = Math.max(1, Math.floor(r1 / 22));
    const x0 = Math.max(0, Math.floor(cx - r1)), x1 = Math.min(w - 1, Math.ceil(cx + r1));
    const y0 = Math.max(0, Math.floor(cy - r1)), y1 = Math.min(h - 1, Math.ceil(cy + r1));
    const a = r0 * r0, b = r1 * r1;
    for (let y = y0; y <= y1; y += step) {
      for (let x = x0; x <= x1; x += step) {
        const d2 = (x - cx) * (x - cx) + (y - cy) * (y - cy);
        if (d2 < a || d2 > b) continue;
        const i = (y * w + x) * 4;
        hist.add(data[i], data[i + 1], data[i + 2]);
      }
    }
    return hist.dominant();
  }

  /* ------------------------------------------------------- circle transform */

  function blur5(src, w, h, tmp) {
    // Separable 1-4-6-4-1 Gaussian.
    for (let y = 0; y < h; y++) {
      const o = y * w;
      for (let x = 0; x < w; x++) {
        const a = src[o + Math.max(0, x - 2)], b = src[o + Math.max(0, x - 1)], c = src[o + x];
        const d = src[o + Math.min(w - 1, x + 1)], e = src[o + Math.min(w - 1, x + 2)];
        tmp[o + x] = (a + 4 * b + 6 * c + 4 * d + e) / 16;
      }
    }
    for (let y = 0; y < h; y++) {
      const ym2 = Math.max(0, y - 2) * w, ym1 = Math.max(0, y - 1) * w, y0 = y * w;
      const yp1 = Math.min(h - 1, y + 1) * w, yp2 = Math.min(h - 1, y + 2) * w;
      for (let x = 0; x < w; x++) src[y0 + x] = (tmp[ym2 + x] + 4 * tmp[ym1 + x] + 6 * tmp[y0 + x] + 4 * tmp[yp1 + x] + tmp[yp2 + x]) / 16;
    }
  }

  /**
   * Find circles. Edges are taken from whichever colour channel changes most,
   * because a red chip on green felt has almost no brightness contrast.
   * Returns [{ x, y, r, score }] with score ≈ share of the circle outline that was found.
   */
  function detectCircles(img, opts) {
    opts = opts || {};
    const w = img.width, h = img.height, n = w * h, data = img.data;
    const minDim = Math.min(w, h);
    const rMin = Math.max(5, Math.round(opts.rMin || minDim * 0.035));
    const rMax = Math.max(rMin + 4, Math.round(opts.rMax || minDim * 0.27));
    const minScore = opts.minScore || 0.42;

    const ch = [new Float32Array(n), new Float32Array(n), new Float32Array(n)];
    for (let i = 0, j = 0; i < n; i++, j += 4) { ch[0][i] = data[j]; ch[1][i] = data[j + 1]; ch[2][i] = data[j + 2]; }
    const tmp = new Float32Array(n);
    for (let c = 0; c < 3; c++) blur5(ch[c], w, h, tmp);

    // Colour Sobel: keep the gradient of the strongest channel.
    const gx = new Float32Array(n), gy = new Float32Array(n), mag = new Float32Array(n);
    const hist = new Uint32Array(256);
    for (let y = 1; y < h - 1; y++) {
      for (let x = 1; x < w - 1; x++) {
        const i = y * w + x;
        let bx = 0, by = 0, bm = -1;
        for (let c = 0; c < 3; c++) {
          const p = ch[c];
          const tl = p[i - w - 1], tc = p[i - w], tr = p[i - w + 1], l = p[i - 1], r = p[i + 1], bl = p[i + w - 1], bc = p[i + w], br = p[i + w + 1];
          const sx = (tr + 2 * r + br - tl - 2 * l - bl) / 4;
          const sy = (bl + 2 * bc + br - tl - 2 * tc - tr) / 4;
          const m = sx * sx + sy * sy;
          if (m > bm) { bm = m; bx = sx; by = sy; }
        }
        const m = Math.sqrt(bm);
        gx[i] = bx; gy[i] = by; mag[i] = m;
        hist[Math.min(255, m | 0)]++;
      }
    }

    // Adaptive threshold: strongest ~12% of gradients, kept inside sane bounds.
    let acc = 0, thr = 255;
    const budget = n * 0.12;
    for (let v = 255; v >= 0; v--) { acc += hist[v]; if (acc > budget) { thr = v; break; } }
    thr = Math.max(opts.edgeMin || 11, Math.min(48, thr));

    // Non-maximum suppression → thin edges, then collect them.
    const ex = [], ey = [], eux = [], euy = [];
    for (let y = 2; y < h - 2; y++) {
      for (let x = 2; x < w - 2; x++) {
        const i = y * w + x, m = mag[i];
        if (m < thr) continue;
        const ux = gx[i] / m, uy = gy[i] / m;
        const dx = Math.round(ux), dy = Math.round(uy);
        if (m < mag[i + dy * w + dx] || m <= mag[i - dy * w - dx]) continue;
        ex.push(x); ey.push(y); eux.push(ux); euy.push(uy);
      }
    }
    const ne = ex.length;
    if (!ne) return [];

    // Stage 1: every edge pixel votes for possible centres along its gradient line.
    const votes = new Float32Array(n);
    for (let k = 0; k < ne; k++) {
      const x = ex[k], y = ey[k], ux = eux[k], uy = euy[k];
      for (let r = rMin; r <= rMax; r++) {
        let cx = (x + r * ux + 0.5) | 0, cy = (y + r * uy + 0.5) | 0;
        if (cx >= 0 && cx < w && cy >= 0 && cy < h) votes[cy * w + cx]++;
        cx = (x - r * ux + 0.5) | 0; cy = (y - r * uy + 0.5) | 0;
        if (cx >= 0 && cx < w && cy >= 0 && cy < h) votes[cy * w + cx]++;
      }
    }
    // 5×5 box sum to pool votes scattered by small direction errors.
    const box = new Float32Array(n);
    for (let y = 0; y < h; y++) {
      const o = y * w;
      for (let x = 2; x < w - 2; x++) tmp[o + x] = votes[o + x - 2] + votes[o + x - 1] + votes[o + x] + votes[o + x + 1] + votes[o + x + 2];
    }
    for (let y = 2; y < h - 2; y++) {
      const o = y * w;
      for (let x = 2; x < w - 2; x++) box[o + x] = tmp[o + x - 2 * w] + tmp[o + x - w] + tmp[o + x] + tmp[o + x + w] + tmp[o + x + 2 * w];
    }

    const thrC = 1.4 * 2 * Math.PI * rMin;
    let peaks = [];
    for (let y = 3; y < h - 3; y++) {
      for (let x = 3; x < w - 3; x++) {
        const i = y * w + x, v = box[i];
        if (v < thrC) continue;
        if (v < box[i - 1] || v < box[i + 1] || v < box[i - w] || v < box[i + w] || v < box[i - w - 1] || v < box[i - w + 1] || v < box[i + w - 1] || v < box[i + w + 1]) continue;
        peaks.push(i);
      }
    }
    peaks.sort((a, b) => box[b] - box[a]);
    if (peaks.length > 600) peaks.length = 600;
    const sep = Math.max(3, rMin * 0.5), sep2 = sep * sep;
    const cands = [];
    for (const i of peaks) {
      const x = i % w, y = (i / w) | 0;
      let ok = true;
      for (const c of cands) { if ((c.x - x) * (c.x - x) + (c.y - y) * (c.y - y) < sep2) { ok = false; break; } }
      if (ok) { cands.push({ x, y }); if (cands.length >= 160) break; }
    }

    // Stage 2: for each centre, histogram the distances of edges that point at it.
    const found = [];
    const rh = new Float32Array(rMax + 4);
    const lim = rMax + 2;
    for (const c of cands) {
      rh.fill(0);
      for (let k = 0; k < ne; k++) {
        const dx = ex[k] - c.x;
        if (dx > lim || dx < -lim) continue;
        const dy = ey[k] - c.y;
        if (dy > lim || dy < -lim) continue;
        const d = Math.sqrt(dx * dx + dy * dy);
        if (d < rMin - 1.5 || d > lim) continue;
        const align = Math.abs(dx * eux[k] + dy * euy[k]) / d;
        if (align < 0.9) continue;
        rh[(d + 0.5) | 0]++;
      }
      let best = 0, bestR = 0;
      const score = (r) => (rh[r - 1] + rh[r] + rh[r + 1]) / (2 * Math.PI * r);
      for (let r = rMin; r <= rMax; r++) { const s = score(r); if (s > best) { best = s; bestR = r; } }
      if (best < minScore) continue;
      // Chips and bimetal coins have inner rings: prefer the outermost strong ring.
      const need = Math.max(minScore * 0.9, best * 0.55);
      let r = bestR;
      for (let q = rMax; q > bestR; q--) { if (score(q) >= need) { r = q; break; } }
      found.push({ x: c.x, y: c.y, r, score: Math.min(1, score(r)), peak: Math.min(1, best) });
    }

    // Drop duplicates and overlaps (stacked pieces can't be counted from above anyway).
    found.sort((a, b) => b.peak + b.r / rMax * 0.1 - (a.peak + a.r / rMax * 0.1));
    const out = [];
    for (const f of found) {
      let ok = true;
      for (const o of out) {
        const d = Math.hypot(f.x - o.x, f.y - o.y);
        if (d < 0.8 * Math.max(f.r, o.r)) { ok = false; break; }
      }
      if (ok) out.push(f);
    }
    return out;
  }

  /** Attach colour measurements to circles: whole face, centre and outer ring. */
  function measureCircles(img, circles) {
    for (const c of circles) {
      c.color = annulusColor(img, c.x, c.y, 0, c.r * 0.9);
      c.inner = annulusColor(img, c.x, c.y, 0, c.r * 0.45);
      c.ring = annulusColor(img, c.x, c.y, c.r * 0.66, c.r * 0.92);
    }
    return circles;
  }

  /* ------------------------------------------------------------- banknotes */

  /**
   * Banknotes: everything that differs from the table colour (sampled along the
   * frame border) is segmented, and blobs that are big, rectangular and about
   * twice as long as wide are kept. Returns [{ cx, cy, w, h, angle, corners, color }].
   */
  function detectNotes(img, circles, opts) {
    opts = opts || {};
    const W = img.width, H = img.height, data = img.data;
    const scale = Math.max(1, Math.max(W, H) / 220);
    const w = Math.max(8, Math.round(W / scale)), h = Math.max(8, Math.round(H / scale)), n = w * h;
    const R = new Float32Array(n), G = new Float32Array(n), B = new Float32Array(n);
    for (let y = 0; y < h; y++) {
      const sy = Math.min(H - 1, Math.round((y + 0.5) * scale));
      for (let x = 0; x < w; x++) {
        const sx = Math.min(W - 1, Math.round((x + 0.5) * scale));
        const j = (sy * W + sx) * 4, i = y * w + x;
        R[i] = data[j]; G[i] = data[j + 1]; B[i] = data[j + 2];
      }
    }
    const tmp = new Float32Array(n);
    blur5(R, w, h, tmp); blur5(G, w, h, tmp); blur5(B, w, h, tmp);

    // Table colour = median of the border frame.
    const br = [], bg = [], bb = [];
    const m = Math.max(2, Math.round(Math.min(w, h) * 0.05));
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      if (x >= m && x < w - m && y >= m && y < h - m) continue;
      const i = y * w + x; br.push(R[i]); bg.push(G[i]); bb.push(B[i]);
    }
    const med = (a) => { a.sort((p, q) => p - q); return a[a.length >> 1]; };
    const tr = med(br.slice()), tg = med(bg.slice()), tb = med(bb.slice());
    const bd = [];
    for (let k = 0; k < br.length; k++) bd.push(Math.hypot(br[k] - tr, bg[k] - tg, bb[k] - tb));
    const spread = med(bd);
    const thr = Math.max(34, spread * 3 + 14);

    const mask = new Uint8Array(n);
    for (let i = 0; i < n; i++) if (Math.hypot(R[i] - tr, G[i] - tg, B[i] - tb) > thr) mask[i] = 1;
    // Coins and chips are not notes.
    for (const c of circles || []) {
      const cx = c.x / scale, cy = c.y / scale, r = (c.r * 1.12) / scale + 1;
      for (let y = Math.max(0, Math.floor(cy - r)); y <= Math.min(h - 1, Math.ceil(cy + r)); y++)
        for (let x = Math.max(0, Math.floor(cx - r)); x <= Math.min(w - 1, Math.ceil(cx + r)); x++)
          if ((x - cx) * (x - cx) + (y - cy) * (y - cy) <= r * r) mask[y * w + x] = 0;
    }
    // Close small gaps (prints, holograms), then label connected blobs.
    const dil = new Uint8Array(n);
    for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      dil[i] = mask[i] | mask[i - 1] | mask[i + 1] | mask[i - w] | mask[i + w];
    }
    const ero = new Uint8Array(n);
    for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      ero[i] = dil[i] & dil[i - 1] & dil[i + 1] & dil[i - w] & dil[i + w];
    }

    const label = new Int32Array(n);
    const notes = [];
    const stack = new Int32Array(n);
    let next = 0;
    for (let s = 0; s < n; s++) {
      if (!ero[s] || label[s]) continue;
      next++;
      let top = 0, area = 0, sx = 0, sy = 0, sxx = 0, syy = 0, sxy = 0, touches = false;
      const px = [];
      stack[top++] = s; label[s] = next;
      while (top) {
        const i = stack[--top];
        const x = i % w, y = (i / w) | 0;
        area++; sx += x; sy += y; sxx += x * x; syy += y * y; sxy += x * y; px.push(i);
        if (x <= 1 || y <= 1 || x >= w - 2 || y >= h - 2) touches = true;
        if (x > 0 && ero[i - 1] && !label[i - 1]) { label[i - 1] = next; stack[top++] = i - 1; }
        if (x < w - 1 && ero[i + 1] && !label[i + 1]) { label[i + 1] = next; stack[top++] = i + 1; }
        if (y > 0 && ero[i - w] && !label[i - w]) { label[i - w] = next; stack[top++] = i - w; }
        if (y < h - 1 && ero[i + w] && !label[i + w]) { label[i + w] = next; stack[top++] = i + w; }
      }
      if (area < n * (opts.minArea || 0.02) || touches) continue;
      const mx = sx / area, my = sy / area;
      const cxx = sxx / area - mx * mx, cyy = syy / area - my * my, cxy = sxy / area - mx * my;
      const ang = 0.5 * Math.atan2(2 * cxy, cxx - cyy);
      const ca = Math.cos(ang), sa = Math.sin(ang);
      const us = [], vs = [];
      for (const i of px) {
        const dx = (i % w) - mx, dy = ((i / w) | 0) - my;
        us.push(dx * ca + dy * sa); vs.push(-dx * sa + dy * ca);
      }
      us.sort((a, b) => a - b); vs.sort((a, b) => a - b);
      const q = (arr, f) => arr[Math.min(arr.length - 1, Math.max(0, Math.round(f * (arr.length - 1))))];
      const u0 = q(us, 0.01), u1 = q(us, 0.99), v0 = q(vs, 0.01), v1 = q(vs, 0.99);
      const len = u1 - u0 + 1, wid = v1 - v0 + 1;
      if (wid < 4) continue;
      const aspect = len / wid, fill = area / (len * wid);
      if (aspect < 1.45 || aspect > 2.5 || fill < 0.72) continue;

      const hist = Histogram();
      const stepPx = Math.max(1, Math.floor(px.length / 1500));
      for (let k = 0; k < px.length; k += stepPx) { const i = px[k]; hist.add(R[i], G[i], B[i]); }
      const uc = (u0 + u1) / 2, vc = (v0 + v1) / 2;
      const cx = (mx + uc * ca - vc * sa) * scale, cy = (my + uc * sa + vc * ca) * scale;
      const L = len * scale, Wd = wid * scale;
      const corner = (a, b) => ({ x: cx + (a * L / 2) * ca - (b * Wd / 2) * sa, y: cy + (a * L / 2) * sa + (b * Wd / 2) * ca });
      notes.push({ cx, cy, w: L, h: Wd, angle: ang, corners: [corner(-1, -1), corner(1, -1), corner(1, 1), corner(-1, 1)], color: hist.dominant(), fill });
    }
    return notes;
  }

  /* ---------------------------------------------------------- classification */

  const CHIP_DEFAULTS = { white: 1, red: 5, blue: 10, gray: 20, green: 25, orange: 50, black: 100, pink: 250, purple: 500, yellow: 1000, teal: 2000, brown: 5000 };

  const CURRENCIES = {
    EUR: {
      symbol: '€',
      coins: [
        { id: '1c', label: '1 ct', value: 0.01, d: 16.25, metal: 'copper' },
        { id: '2c', label: '2 ct', value: 0.02, d: 18.75, metal: 'copper' },
        { id: '5c', label: '5 ct', value: 0.05, d: 21.25, metal: 'copper' },
        { id: '10c', label: '10 ct', value: 0.1, d: 19.75, metal: 'gold' },
        { id: '20c', label: '20 ct', value: 0.2, d: 22.25, metal: 'gold' },
        { id: '50c', label: '50 ct', value: 0.5, d: 24.25, metal: 'gold' },
        { id: '1e', label: '€1', value: 1, d: 23.25, metal: 'bi-gold-ring' },
        { id: '2e', label: '€2', value: 2, d: 25.75, metal: 'bi-silver-ring' },
      ],
      notes: [
        { id: 'n5', label: '€5', value: 5, len: 120, hue: null },
        { id: 'n10', label: '€10', value: 10, len: 127, hue: 355 },
        { id: 'n20', label: '€20', value: 20, len: 133, hue: 215 },
        { id: 'n50', label: '€50', value: 50, len: 140, hue: 28 },
        { id: 'n100', label: '€100', value: 100, len: 147, hue: 110 },
        { id: 'n200', label: '€200', value: 200, len: 153, hue: 52 },
      ],
    },
    GBP: {
      symbol: '£',
      coins: [
        { id: '1p', label: '1p', value: 0.01, d: 20.3, metal: 'copper' },
        { id: '2p', label: '2p', value: 0.02, d: 25.9, metal: 'copper' },
        { id: '5p', label: '5p', value: 0.05, d: 18.0, metal: 'silver' },
        { id: '10p', label: '10p', value: 0.1, d: 24.5, metal: 'silver' },
        { id: '20p', label: '20p', value: 0.2, d: 21.4, metal: 'silver' },
        { id: '50p', label: '50p', value: 0.5, d: 27.3, metal: 'silver' },
        { id: '1l', label: '£1', value: 1, d: 23.43, metal: 'bi-gold-ring' },
        { id: '2l', label: '£2', value: 2, d: 28.4, metal: 'bi-gold-ring' },
      ],
      notes: [
        { id: 'n5', label: '£5', value: 5, len: 125, hue: 178 },
        { id: 'n10', label: '£10', value: 10, len: 132, hue: 28 },
        { id: 'n20', label: '£20', value: 20, len: 139, hue: 280 },
        { id: 'n50', label: '£50', value: 50, len: 146, hue: 355 },
      ],
    },
  };

  /** Colour-histogram clustering: circles with similar face colours become one chip type. */
  function classifyChips(circles) {
    const feat = (c) => {
      const a = (c.h * Math.PI) / 180;
      return [c.s * Math.cos(a), c.s * Math.sin(a), c.v * 0.7];
    };
    const clusters = [];
    for (const c of circles) {
      // The rim carries the chip colour; printed inlays sit in the middle.
      const col = c.ring && c.ring.share > 0.45 ? c.ring : c.color;
      const f = feat(col);
      let best = null, bd = 0.2;
      for (const cl of clusters) {
        const d = Math.hypot(f[0] - cl.f[0], f[1] - cl.f[1], f[2] - cl.f[2]);
        if (d < bd) { bd = d; best = cl; }
      }
      if (!best) { best = { f: f.slice(), n: 0, r: 0, g: 0, b: 0, items: [] }; clusters.push(best); }
      best.items.push(c);
      best.n++; best.r += col.r; best.g += col.g; best.b += col.b;
      for (let k = 0; k < 3; k++) best.f[k] += (f[k] - best.f[k]) / best.n;
    }
    const byName = new Map();
    for (const cl of clusters) {
      const col = makeColor(cl.r / cl.n, cl.g / cl.n, cl.b / cl.n);
      let g = byName.get(col.name);
      if (!g) { g = { key: col.name, name: col.name, hex: col.hex, items: [] }; byName.set(col.name, g); }
      for (const c of cl.items) { c.group = col.name; g.items.push(c); }
    }
    return [...byName.values()].sort((a, b) => b.items.length - a.items.length);
  }

  function metalOf(c) {
    if (c.s < 0.2) return 'silver';
    if (c.h >= 345 || c.h < 33) return 'copper';
    if (c.h < 75) return 'gold';
    return 'silver';
  }

  function coinMetal(c) {
    const inner = metalOf(c.inner), ring = metalOf(c.ring);
    const warm = (m) => m !== 'silver';
    if (warm(ring) && !warm(inner)) return 'bi-gold-ring';
    if (!warm(ring) && warm(inner)) return 'bi-silver-ring';
    return metalOf(c.color);
  }

  function metalPenalty(seen, spec) {
    if (seen === spec) return 0;
    const bi = (m) => m.startsWith('bi-');
    if (bi(seen) !== bi(spec)) return 0.006;
    return 0.005;
  }

  /**
   * Coins: there is no ruler in the picture, so the scale (mm per pixel) is the one
   * that makes all coins fit real diameters best, with metal colour as a soft constraint.
   * Returns { mmPerPx, ambiguous } and sets c.denom on every circle.
   */
  function classifyCoins(circles, currency) {
    const cur = CURRENCIES[currency] || CURRENCIES.EUR;
    if (!circles.length) return { mmPerPx: null, ambiguous: false };
    for (const c of circles) c.metal = coinMetal(c);
    const fit = (s) => {
      let total = 0;
      const picks = [];
      for (const c of circles) {
        let best = Infinity, pick = null;
        for (const dn of cur.coins) {
          const rel = (2 * c.r * s - dn.d) / dn.d;
          const cost = rel * rel + metalPenalty(c.metal, dn.metal);
          if (cost < best) { best = cost; pick = dn; }
        }
        total += Math.min(best, 0.05);
        picks.push(pick);
      }
      return { total, picks };
    };
    let best = null;
    for (const c of circles) {
      for (const dn of cur.coins) {
        const s = dn.d / (2 * c.r);
        const f = fit(s);
        // Slight preference for common everyday scales breaks exact ties deterministically.
        if (!best || f.total < best.total - 1e-9) best = { ...f, s };
      }
    }
    circles.forEach((c, i) => { c.denom = best.picks[i]; });
    const rs = circles.map((c) => c.r);
    const spreadR = Math.max(...rs) / Math.min(...rs);
    const metals = new Set(circles.map((c) => c.metal));
    return { mmPerPx: best.s, ambiguous: spreadR < 1.06 && metals.size < 2 };
  }

  function hueDist(a, b) {
    const d = Math.abs(a - b) % 360;
    return Math.min(d, 360 - d) / 180;
  }

  /** Banknotes by dominant colour, plus length when coins in the same photo give a scale. */
  function classifyNotes(notes, currency, mmPerPx) {
    const cur = CURRENCIES[currency] || CURRENCIES.EUR;
    for (const nt of notes) {
      const col = nt.color;
      let best = Infinity, pick = cur.notes[0];
      for (const dn of cur.notes) {
        let cost;
        if (dn.hue == null) cost = col.s < 0.2 ? 0 : 0.25 + col.s * 0.5;
        else cost = col.s < 0.14 ? 0.6 : hueDist(col.h, dn.hue);
        if (mmPerPx) { const rel = (nt.w * mmPerPx - dn.len) / dn.len; cost += Math.min(0.5, rel * rel * 40); }
        if (cost < best) { best = cost; pick = dn; }
      }
      nt.denom = pick;
    }
    return notes;
  }

  return { detectCircles, measureCircles, detectNotes, classifyChips, classifyCoins, classifyNotes, annulusColor, colorName, rgbToHsv, makeColor, CURRENCIES, CHIP_DEFAULTS };
});
