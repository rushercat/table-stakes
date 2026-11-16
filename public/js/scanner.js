/**
 * Buy-in scanner UI: live camera (getUserMedia) with a photo fallback, detection overlay,
 * and an editable count so a wrong guess never ends up in someone's stack.
 * The vision code lives in scanner-cv.js; nothing is uploaded anywhere.
 */
(() => {
  'use strict';
  const CV = window.ScannerCV;
  const $ = (s, r = document) => r.querySelector(s);
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const r2 = (x) => Math.round((x + Number.EPSILON) * 100) / 100;
  const fmt = (n) => { const v = r2(n); return Number.isInteger(v) ? v.toLocaleString('en-US') : v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); };
  const ls = {
    get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* ignore */ } },
  };
  const cap = (s) => s[0].toUpperCase() + s.slice(1);
  const ANALYSIS_SIDE = 640, LIVE_SIDE = 320, VIEW_SIDE = 960;

  let st = null;

  function open(opts) {
    close();
    st = {
      opts: opts || {},
      mode: ls.get('ts.scanMode', 'chips'),      // chips | EUR | GBP
      phase: 'live',                              // live | review
      stream: null, video: null, raf: 0, lastLive: 0,
      liveItems: [], liveScale: 1,
      frame: null, items: [], rows: [], scale: 1, ambiguous: false,
      camError: '',
    };
    const root = $('#scanner-root');
    root.innerHTML = `
      <div class="scanner" role="dialog" aria-modal="true" aria-label="Scan chips or cash">
        <header class="scan-bar">
          <button class="icon-x" data-s="close" aria-label="Close scanner">×</button>
          <div class="seg small" id="scan-modes"></div>
        </header>
        <div class="scan-view"><canvas id="scan-canvas"></canvas><video id="scan-video" playsinline muted autoplay></video><p class="scan-tip" id="scan-tip"></p></div>
        <div class="scan-panel" id="scan-panel"></div>
        <input type="file" id="scan-file" accept="image/*" capture="environment" hidden>
      </div>`;
    root.addEventListener('click', onClick);
    root.addEventListener('input', onInput);
    $('#scan-file').addEventListener('change', onFile);
    $('#scan-canvas').addEventListener('click', onCanvasTap);
    paintModes();
    paintPanel();
    startCamera();
  }

  function close() {
    if (!st) return;
    cancelAnimationFrame(st.raf);
    if (st.stream) st.stream.getTracks().forEach((t) => t.stop());
    const root = $('#scanner-root');
    root.removeEventListener('click', onClick);
    root.removeEventListener('input', onInput);
    root.innerHTML = '';
    st = null;
  }

  /* ------------------------------------------------------------- camera */
  async function startCamera() {
    if (!window.isSecureContext || !navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      st.camError = window.isSecureContext ? 'This browser has no live camera access.' : 'The live camera only works over HTTPS.';
      paintPanel();
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } } });
      if (!st) { stream.getTracks().forEach((t) => t.stop()); return; }
      st.stream = stream;
      st.video = $('#scan-video');
      st.video.srcObject = stream;
      await st.video.play().catch(() => {});
      st.camError = '';
      paintPanel();
      loop();
    } catch (e) {
      if (!st) return;
      st.camError = e && e.name === 'NotAllowedError' ? 'Camera access is blocked for this site.' : 'No camera could be started.';
      paintPanel();
    }
  }

  function fit(w, h, side) {
    const k = Math.min(1, side / Math.max(w, h));
    return { w: Math.max(1, Math.round(w * k)), h: Math.max(1, Math.round(h * k)) };
  }
  function grab(source, sw, sh, side) {
    const { w, h } = fit(sw, sh, side);
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(source, 0, 0, w, h);
    return { canvas: c, image: ctx.getImageData(0, 0, w, h) };
  }

  function loop() {
    if (!st || st.phase !== 'live' || !st.video) return;
    const v = st.video;
    if (v.videoWidth) {
      const canvas = $('#scan-canvas');
      const { w, h } = fit(v.videoWidth, v.videoHeight, VIEW_SIDE);
      if (canvas.width !== w) { canvas.width = w; canvas.height = h; }
      const ctx = canvas.getContext('2d');
      ctx.drawImage(v, 0, 0, w, h);
      const now = performance.now();
      if (now - st.lastLive > 380) {
        st.lastLive = now;
        const g = grab(v, v.videoWidth, v.videoHeight, LIVE_SIDE);
        const circles = CV.detectCircles(g.image);
        const notes = st.mode === 'chips' ? [] : CV.detectNotes(g.image, circles);
        st.liveItems = circles.map((c) => ({ type: 'c', x: c.x, y: c.y, r: c.r })).concat(notes.map((n) => ({ type: 'n', corners: n.corners })));
        st.liveScale = w / g.image.width;
        const tip = $('#scan-tip');
        if (tip) tip.textContent = st.liveItems.length ? `${st.liveItems.length} ${st.liveItems.length === 1 ? 'piece' : 'pieces'} in view` : 'Lay everything flat, side by side, and hold the phone straight above';
      }
      drawItems(ctx, st.liveItems, st.liveScale, false);
    }
    st.raf = requestAnimationFrame(loop);
  }

  function drawItems(ctx, items, k, labels) {
    ctx.save();
    ctx.lineJoin = 'round';
    const lw = Math.max(2, ctx.canvas.width / 240);
    for (const it of items) {
      ctx.lineWidth = lw;
      ctx.strokeStyle = it.off ? 'rgba(200,68,58,.9)' : '#f4d98b';
      ctx.setLineDash(it.off ? [lw * 3, lw * 3] : []);
      ctx.beginPath();
      let lx, ly;
      if (it.type === 'c') { ctx.arc(it.x * k, it.y * k, it.r * k, 0, Math.PI * 2); lx = it.x * k; ly = it.y * k; }
      else { it.corners.forEach((p, i) => (i ? ctx.lineTo(p.x * k, p.y * k) : ctx.moveTo(p.x * k, p.y * k))); ctx.closePath(); lx = it.corners.reduce((s, p) => s + p.x, 0) / 4 * k; ly = it.corners.reduce((s, p) => s + p.y, 0) / 4 * k; }
      ctx.stroke();
      if (labels && it.label && !it.off) {
        const fs = Math.max(13, ctx.canvas.width / 38);
        ctx.font = `600 ${fs}px "Barlow Semi Condensed", system-ui, sans-serif`;
        const tw = ctx.measureText(it.label).width + fs * 0.7;
        ctx.setLineDash([]);
        ctx.fillStyle = 'rgba(6,18,13,.82)';
        ctx.beginPath();
        if (ctx.roundRect) ctx.roundRect(lx - tw / 2, ly - fs * 0.75, tw, fs * 1.5, fs * 0.4); else ctx.rect(lx - tw / 2, ly - fs * 0.75, tw, fs * 1.5);
        ctx.fill();
        ctx.fillStyle = '#f4d98b';
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillText(it.label, lx, ly + 1);
      }
    }
    ctx.restore();
  }

  /* ----------------------------------------------------------- analysis */
  function analyze(source, sw, sh) {
    const g = grab(source, sw, sh, ANALYSIS_SIDE);
    const view = grab(source, sw, sh, VIEW_SIDE);
    st.frame = view.canvas;
    st.scale = view.canvas.width / g.image.width;
    const img = g.image;
    const circles = CV.measureCircles(img, CV.detectCircles(img));
    st.items = [];
    st.ambiguous = false;

    if (st.mode === 'chips') {
      const saved = ls.get('ts.chipValues', {});
      const groups = CV.classifyChips(circles);
      st.rows = groups.map((g2) => ({ key: g2.key, label: cap(g2.name), swatch: g2.hex, count: g2.items.length, value: saved[g2.key] != null ? saved[g2.key] : (CV.CHIP_DEFAULTS[g2.key] || 0), editable: true }));
      for (const c of circles) st.items.push({ type: 'c', x: c.x, y: c.y, r: c.r, key: c.group, label: cap(c.group) });
    } else {
      const cur = CV.CURRENCIES[st.mode];
      const info = CV.classifyCoins(circles, st.mode);
      st.ambiguous = circles.length > 0 && info.ambiguous;
      const scaleKnown = circles.length >= 2 && !info.ambiguous ? info.mmPerPx : null;
      const notes = CV.classifyNotes(CV.detectNotes(img, circles), st.mode, scaleKnown);
      const counts = {};
      for (const c of circles) { counts[c.denom.id] = (counts[c.denom.id] || 0) + 1; st.items.push({ type: 'c', x: c.x, y: c.y, r: c.r, key: c.denom.id, label: c.denom.label }); }
      for (const n of notes) { counts[n.denom.id] = (counts[n.denom.id] || 0) + 1; st.items.push({ type: 'n', corners: n.corners, key: n.denom.id, label: n.denom.label }); }
      st.rows = cur.notes.slice().reverse().map((d) => ({ key: d.id, label: d.label, value: d.value, count: counts[d.id] || 0, note: true }))
        .concat(cur.coins.slice().reverse().map((d) => ({ key: d.id, label: d.label, value: d.value, count: counts[d.id] || 0 })));
    }
    st.phase = 'review';
    cancelAnimationFrame(st.raf);
    paintFrame();
    paintPanel();
  }

  function paintFrame() {
    const canvas = $('#scan-canvas');
    canvas.width = st.frame.width; canvas.height = st.frame.height;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(st.frame, 0, 0);
    drawItems(ctx, st.items, st.scale, true);
    const tip = $('#scan-tip');
    if (tip) tip.textContent = st.items.length ? 'Tap a piece to leave it out' : 'Nothing found — count by hand below or try again';
  }

  /* -------------------------------------------------------------- panel */
  function totals() {
    if (st.mode === 'chips') {
      const chips = st.rows.reduce((s, r) => s + r.count * (Number(r.value) || 0), 0);
      return { chips: st.opts.whole ? Math.round(chips) : r2(chips), money: null };
    }
    const money = r2(st.rows.reduce((s, r) => s + r.count * r.value, 0));
    const rate = Number(ls.get('ts.rate.' + st.mode, 100)) || 0;
    const chips = money * rate;
    return { chips: st.opts.whole ? Math.round(chips) : r2(chips), money, rate };
  }

  function paintModes() {
    $('#scan-modes').innerHTML = [['chips', 'Chips'], ['EUR', 'Euro cash'], ['GBP', 'Pound cash']]
      .map(([k, label]) => `<button data-s="mode" data-mode="${k}" class="${st.mode === k ? 'on' : ''}">${label}</button>`).join('');
  }

  function paintPanel() {
    const panel = $('#scan-panel');
    if (!panel) return;
    if (st.phase === 'live') {
      const hasCam = !!st.stream;
      panel.innerHTML = `
        ${st.camError ? `<p class="scan-msg">${esc(st.camError)} Take a photo instead — it is counted the same way.</p>` : ''}
        <div class="scan-live">
          ${hasCam ? '<button class="shutter" data-s="capture" aria-label="Count what the camera sees"><i></i></button>' : ''}
          <button class="btn ${hasCam ? 'ghost' : 'gold'} ${hasCam ? 'sm' : 'wide'}" data-s="photo">${hasCam ? 'Use a photo' : 'Take a photo'}</button>
          <button class="btn ghost ${hasCam ? 'sm' : 'wide'}" data-s="manual">Count by hand</button>
        </div>
        <p class="fine center">${st.mode === 'chips' ? 'Chips are told apart by colour. You set what each colour is worth.' : 'Coins are told apart by size and metal colour, notes by colour. Include two or more different coins for the best guess.'}</p>`;
      return;
    }
    const t = totals();
    const sym = st.mode === 'chips' ? '' : CV.CURRENCIES[st.mode].symbol;
    const stepper = (r) => `<div class="cnt"><button data-s="dec" data-key="${r.key}" aria-label="One less">−</button><b>${r.count}</b><button data-s="inc" data-key="${r.key}" aria-label="One more">+</button></div>`;
    let rows;
    if (st.mode === 'chips') {
      rows = st.rows.length
        ? st.rows.map((r) => `<div class="srow"><i class="sw" style="background:${r.swatch}"></i><span class="sname">${esc(r.label)}</span>${stepper(r)}<label class="sval">×<input inputmode="decimal" data-val="${r.key}" value="${esc(r.value)}" aria-label="Value of one ${esc(r.label)} chip"></label></div>`).join('')
        : '<p class="scan-msg">No chips found. Try again with more light and the chips laid flat, side by side.</p>';
    } else {
      rows = `<div class="cash-grid">${st.rows.map((r) => `<div class="srow ${r.count ? '' : 'zero'} ${r.note ? 'note' : ''}"><span class="sname">${esc(r.label)}</span>${stepper(r)}</div>`).join('')}</div>
        <label class="rate">${sym}1 is worth <input inputmode="decimal" data-rate value="${esc(t.rate)}" aria-label="Chips per ${sym}1"> chips</label>`;
    }
    panel.innerHTML = `
      ${st.ambiguous ? '<p class="scan-msg">Coins of one size and colour cannot be told apart without a second coin for scale — check the counts.</p>' : ''}
      <div class="scan-rows">${rows}</div>
      <div class="scan-total"><span>${t.money != null ? `${sym}${t.money.toFixed(2)} counted` : 'Counted'}</span><b id="scan-sum">${fmt(t.chips)} chips</b></div>
      <div class="actions two"><button class="btn ghost" data-s="again">Scan again</button><button class="btn gold" data-s="done" id="scan-done" ${t.chips > 0 ? '' : 'disabled'}>Add ${fmt(t.chips)}</button></div>`;
  }

  function refreshTotal() {
    const t = totals();
    const sum = $('#scan-sum'), done = $('#scan-done');
    if (sum) sum.textContent = `${fmt(t.chips)} chips`;
    if (done) { done.textContent = `Add ${fmt(t.chips)}`; done.disabled = !(t.chips > 0); }
  }

  /* ------------------------------------------------------------- events */
  function onClick(e) {
    const el = e.target.closest('[data-s]');
    if (!el || !st) return;
    const s = el.dataset.s;
    if (s === 'close') return close();
    if (s === 'mode') {
      st.mode = el.dataset.mode; ls.set('ts.scanMode', st.mode); paintModes();
      if (st.phase === 'review') again(); else paintPanel();
      return;
    }
    if (s === 'capture') { const v = st.video; if (v && v.videoWidth) analyze(v, v.videoWidth, v.videoHeight); return; }
    if (s === 'photo') return $('#scan-file').click();
    if (s === 'manual') return manual();
    if (s === 'again') return again();
    if (s === 'inc' || s === 'dec') {
      const row = st.rows.find((r) => r.key === el.dataset.key);
      if (row) { row.count = Math.max(0, row.count + (s === 'inc' ? 1 : -1)); paintPanel(); }
      return;
    }
    if (s === 'done') {
      const t = totals();
      if (!(t.chips > 0)) return;
      const used = st.rows.filter((r) => r.count > 0);
      let note = st.mode === 'chips' ? used.map((r) => `${r.count}×${r.label.toLowerCase()}`).join(', ') : `${CV.CURRENCIES[st.mode].symbol}${t.money.toFixed(2)} in cash`;
      note = ('scan: ' + note).slice(0, 88);
      const done = st.opts.onDone;
      close();
      if (done) done({ amount: t.chips, note });
    }
  }

  function again() {
    st.phase = 'live'; st.items = []; st.rows = []; st.frame = null; st.ambiguous = false;
    paintPanel();
    if (st.stream) loop();
    else { const c = $('#scan-canvas'); c.getContext('2d').clearRect(0, 0, c.width, c.height); $('#scan-tip').textContent = ''; }
  }

  /** No picture at all: just tap in how many of each. */
  function manual() {
    st.items = []; st.ambiguous = false; st.phase = 'review';
    cancelAnimationFrame(st.raf);
    if (st.mode === 'chips') {
      const saved = ls.get('ts.chipValues', {});
      st.rows = ['white', 'red', 'blue', 'green', 'black'].map((k) => ({ key: k, label: cap(k), swatch: { white: '#ece8de', red: '#c4262c', blue: '#2446aa', green: '#28963c', black: '#1c1c1e' }[k], count: 0, value: saved[k] != null ? saved[k] : CV.CHIP_DEFAULTS[k] }));
    } else {
      const cur = CV.CURRENCIES[st.mode];
      st.rows = cur.notes.slice().reverse().map((d) => ({ key: d.id, label: d.label, value: d.value, count: 0, note: true })).concat(cur.coins.slice().reverse().map((d) => ({ key: d.id, label: d.label, value: d.value, count: 0 })));
    }
    $('#scan-tip').textContent = 'Counting by hand';
    paintPanel();
  }

  function onInput(e) {
    const el = e.target;
    if (el.dataset.val != null) {
      const row = st.rows.find((r) => r.key === el.dataset.val);
      const v = Number(el.value.replace(',', '.'));
      if (row && Number.isFinite(v) && v >= 0) {
        row.value = v;
        const saved = ls.get('ts.chipValues', {});
        saved[row.key] = v;
        ls.set('ts.chipValues', saved);
        refreshTotal();
      }
    } else if (el.dataset.rate != null) {
      const v = Number(el.value.replace(',', '.'));
      if (Number.isFinite(v) && v >= 0) { ls.set('ts.rate.' + st.mode, v); refreshTotal(); }
    }
  }

  function onFile(e) {
    const file = e.target.files && e.target.files[0];
    e.target.value = '';
    if (!file || !st) return;
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => { if (st) analyze(img, img.naturalWidth, img.naturalHeight); URL.revokeObjectURL(url); };
    img.onerror = () => { URL.revokeObjectURL(url); if (window.TableStakes) window.TableStakes.toast('That photo could not be read.', 'error'); };
    img.src = url;
  }

  function onCanvasTap(e) {
    if (!st || st.phase !== 'review' || !st.items.length) return;
    const canvas = e.currentTarget;
    const box = canvas.getBoundingClientRect();
    // The canvas is letterboxed (object-fit: contain) inside its box.
    const k = Math.min(box.width / canvas.width, box.height / canvas.height);
    const ox = (box.width - canvas.width * k) / 2, oy = (box.height - canvas.height * k) / 2;
    const x = (e.clientX - box.left - ox) / k / st.scale, y = (e.clientY - box.top - oy) / k / st.scale;
    const hit = st.items.find((it) => {
      if (it.type === 'c') return Math.hypot(it.x - x, it.y - y) <= it.r * 1.1;
      let inside = false;
      for (let i = 0, j = 3; i < 4; j = i++) {
        const a = it.corners[i], b = it.corners[j];
        if ((a.y > y) !== (b.y > y) && x < ((b.x - a.x) * (y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
      }
      return inside;
    });
    if (!hit) return;
    hit.off = !hit.off;
    const row = st.rows.find((r) => r.key === hit.key);
    if (row) row.count = Math.max(0, row.count + (hit.off ? -1 : 1));
    paintFrame();
    paintPanel();
  }

  window.Scanner = { open, close };
})();
