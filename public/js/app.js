/* Table Stakes client — vanilla JS, no build step. */
(() => {
  'use strict';

  /* ------------------------------------------------------------ helpers */
  const $ = (s, r = document) => r.querySelector(s);
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const r2 = (x) => Math.round((x + Number.EPSILON) * 100) / 100;
  const fmt = (n) => {
    const v = r2(Number(n) || 0);
    return Number.isInteger(v) ? v.toLocaleString('en-US') : v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  };
  const signed = (n) => (n > 0 ? '+' : n < 0 ? '−' : '') + fmt(Math.abs(n));
  const ls = {
    get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* private mode */ } },
    del(k) { try { localStorage.removeItem(k); } catch (e) { /* ignore */ } },
  };
  function setHTML(el, html) {
    if (!el || el._html === html) return false;
    el._html = html;
    el.innerHTML = html;
    return true;
  }

  /* -------------------------------------------------------------- state */
  let S = null;                         // latest table state from the server
  let session = ls.get('ts.session', null);
  let view = session ? 'connecting' : 'home';
  let mounted = null;
  let homeMsg = '';
  let retryTimer = null;
  let wakeLock = null;
  const ui = {
    homeMode: 'poker', form: {},
    raiseOpen: false, raiseTo: 0, actFor: null,
    bjBet: 0, dealerTools: false,
    awardSel: {}, sheet: null, lastTurnKey: '',
  };

  const P = (id) => S.players.find((p) => p.id === id);
  const me = () => P(session.playerId) || {};
  const isHost = () => S && session && S.hostId === session.playerId;
  const nameOf = (id) => (P(id) || {}).name || 'Player';

  /* ------------------------------------------------------------- socket */
  const socket = io({ transports: ['websocket', 'polling'], reconnectionDelay: 400, reconnectionDelayMax: 2500, timeout: 8000 });

  function send(type, payload, done) {
    if (!socket.connected) { toast('Not connected — one moment…', 'warn'); return; }
    socket.emit('action', { type, ...(payload || {}) }, (res) => {
      if (!res.ok) toast(res.error || 'That did not work.', 'error');
      if (done) done(res);
    });
  }

  function setSession(s) { session = s; if (s) ls.set('ts.session', s); else { ls.del('ts.session'); ls.del('ts.backup'); } }

  function rejoin() {
    if (!session) return;
    socket.emit('room:rejoin', session, (res) => {
      if (res.ok) return;
      if (res.reason === 'no_room') {
        // The server restarted. The host's phone holds a backup and brings the table back.
        const b = ls.get('ts.backup', null);
        if (b && b.code === session.code && b.hostId === session.playerId) {
          socket.emit('room:restore', { backup: b, playerId: session.playerId, token: session.token }, (r) => {
            if (!r.ok) { view = 'lost'; render(); }
          });
        } else { view = 'lost'; render(); }
      } else {
        setSession(null); S = null; view = 'home'; homeMsg = res.error || ''; render();
      }
    });
  }

  socket.on('connect', () => { $('#net').hidden = true; if (session) rejoin(); });
  socket.on('disconnect', () => { if (session) $('#net').hidden = false; });
  socket.on('state', (st) => {
    if (!session || st.code !== session.code) return;
    if (!st.players.some((p) => p.id === session.playerId && !p.left)) return; // on my way out
    const first = !S;
    S = st;
    S.skew = st.now - Date.now(); // server clock minus this phone's clock
    view = 'table';
    if (first) { ui.bjBet = 0; keepAwake(); }
    render();
  });
  socket.on('backup', (b) => ls.set('ts.backup', b));
  socket.on('removed', (m) => {
    setSession(null); S = null; view = 'home'; closeSheet();
    homeMsg = m && m.kicked ? 'The host removed you from the table.' : '';
    render();
  });
  socket.on('replaced', () => { view = 'replaced'; render(); });

  // Phones drop the connection when the screen locks. Catch up the moment we are visible again.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    if (!socket.connected) socket.connect(); else if (session) socket.emit('sync');
    keepAwake();
  });
  window.addEventListener('online', () => { if (!socket.connected) socket.connect(); });
  window.addEventListener('pageshow', () => { if (!socket.connected) socket.connect(); });

  async function keepAwake() {
    if (view !== 'table' || !('wakeLock' in navigator) || document.visibilityState !== 'visible') return;
    try { if (!wakeLock || wakeLock.released) wakeLock = await navigator.wakeLock.request('screen'); } catch (e) { /* battery saver etc. */ }
  }

  /* -------------------------------------------------------------- toast */
  function toast(msg, kind) {
    const el = document.createElement('div');
    el.className = 'toast ' + (kind || '');
    el.textContent = msg;
    $('#toasts').appendChild(el);
    setTimeout(() => { el.classList.add('bye'); setTimeout(() => el.remove(), 300); }, 3200);
  }

  /* ------------------------------------------------------------- render */
  function render() {
    const app = $('#app');
    clearTimeout(retryTimer);
    if (view === 'table' && S) {
      if (mounted !== 'table') {
        app._html = null;
        app.innerHTML = `
          <div class="table-screen ${S.mode}">
            <header class="bar">
              <button class="code" data-act="share" aria-label="Invite players"><span>Table</span><b>${esc(S.code)}</b></button>
              <div class="bar-title" id="bar-title"></div>
              <button class="icon-btn" data-act="menu" aria-label="Menu"><i></i><i></i><i></i></button>
            </header>
            <div class="ticker" id="ticker"></div>
            <div class="alerts" id="alerts"></div>
            <main class="felt-wrap" id="felt"></main>
            <footer class="dock" id="dock"></footer>
          </div>`;
        mounted = 'table';
      }
      renderTable();
      renderSheet(false);
      return;
    }
    mounted = view;
    closeSheet();
    if (view === 'lost') {
      setHTML(app, `<main class="home notice"><div class="brand"><div class="brand-chip"></div><h1>Table ${esc(session.code)} is asleep</h1>
        <p>The server restarted and is waiting for the host's phone to bring the table back. Ask the host to open the app — you will be seated again automatically.</p></div>
        <button class="btn gold wide" data-act="retry">Try again now</button>
        <button class="btn ghost wide" data-act="forget">Leave this table</button></main>`);
      retryTimer = setTimeout(() => { if (view === 'lost' && socket.connected) rejoin(); else if (view === 'lost') render(); }, 4000);
    } else if (view === 'replaced') {
      setHTML(app, `<main class="home notice"><div class="brand"><div class="brand-chip"></div><h1>Open somewhere else</h1>
        <p>Your seat is now being used in another tab or on another phone.</p></div>
        <button class="btn gold wide" data-act="retry">Use it here instead</button></main>`);
    } else if (view === 'connecting') {
      setHTML(app, `<main class="home notice"><div class="brand"><div class="brand-chip spin"></div><h1>Back to table ${esc(session.code)}</h1><p>Finding your seat…</p></div>
        <button class="btn ghost wide" data-act="forget">Leave this table</button></main>`);
    } else {
      setHTML(app, homeHTML());
    }
  }

  /* --------------------------------------------------------------- home */
  function homeHTML() {
    const f = ui.form;
    const code = f.code != null ? f.code : (new URLSearchParams(location.search).get('room') || '');
    const name = f.name != null ? f.name : ls.get('ts.name', '');
    const poker = ui.homeMode === 'poker';
    const field = (key, label, def) => `<label class="field"><span>${label}</span><input data-bind="${key}" inputmode="numeric" pattern="[0-9]*" value="${esc(f[key] != null ? f[key] : def)}"></label>`;
    return `
      <main class="home">
        <header class="brand">
          <div class="brand-chip" aria-hidden="true"></div>
          <h1>Table Stakes</h1>
          <p>Real cards on the table. Chips on your phones.</p>
        </header>
        ${homeMsg ? `<p class="home-msg">${esc(homeMsg)}</p>` : ''}
        <label class="field name"><span>Your name</span><input data-bind="name" maxlength="16" autocomplete="nickname" autocapitalize="words" placeholder="What the table calls you" value="${esc(name)}"></label>
        <section class="panel">
          <h2>Join a table</h2>
          <div class="join-row">
            <input class="code-input" data-bind="code" inputmode="numeric" pattern="[0-9]*" maxlength="4" placeholder="0000" aria-label="Four-digit table code" value="${esc(code)}">
            <button class="btn gold" data-act="join">Join</button>
          </div>
        </section>
        <section class="panel">
          <h2>Host a table</h2>
          <div class="seg">
            <button data-act="home-mode" data-mode="poker" class="${poker ? 'on' : ''}">Poker</button>
            <button data-act="home-mode" data-mode="blackjack" class="${poker ? '' : 'on'}">Blackjack</button>
          </div>
          <div class="grid3">
            ${field('startingStack', 'Starting stack', 1000)}
            ${poker ? field('smallBlind', 'Small blind', 5) + field('bigBlind', 'Big blind', 10) : field('minBet', 'Minimum bet', 10) + field('maxBet', 'Maximum bet', 500)}
          </div>
          <p class="fine">Set the starting stack to 0 if everyone buys in by scanning real chips or cash, or by typing an amount.</p>
          <button class="btn gold wide" data-act="host">Open a ${poker ? 'poker' : 'blackjack'} table</button>
        </section>
        <p class="fine center">It only keeps count. No accounts, and no money moves through the app.</p>
      </main>`;
  }

  function enter(res) {
    if (!res.ok) { toast(res.error || 'Could not open the table.', 'error'); return; }
    setSession({ code: res.code, playerId: res.playerId, token: res.token });
    homeMsg = '';
    history.replaceState(null, '', '/?room=' + res.code);
  }

  /* -------------------------------------------------------------- table */
  function renderTable() {
    const m = me();
    setHTML($('#bar-title'), S.mode === 'poker'
      ? `<b>Hold'em</b><span>Blinds ${fmt(S.settings.smallBlind)}/${fmt(S.settings.bigBlind)}</span>`
      : `<b>Blackjack</b><span>Bets ${fmt(S.settings.minBet)}–${fmt(S.settings.maxBet)}</span>`);
    const last = S.log[S.log.length - 1];
    setHTML($('#ticker'), last ? `<span data-k="${last.id}">${esc(last.msg)}</span>` : '');
    setHTML($('#alerts'), alertsHTML());
    if (S.mode === 'poker') {
      setHTML($('#felt'), pokerFeltHTML());
      if (setHTML($('#dock'), pokerDockHTML())) syncRaise();
      const h = S.hand;
      const key = h ? h.no + ':' + h.street + ':' + h.toActId + ':' + h.currentBet : '';
      if (h && h.toActId === m.id && key !== ui.lastTurnKey && navigator.vibrate) navigator.vibrate(70);
      ui.lastTurnKey = key;
    } else {
      setHTML($('#felt'), bjFeltHTML());
      if (setHTML($('#dock'), bjDockHTML())) syncBjBet();
    }
  }

  function alertsHTML() {
    const out = [];
    const m = me();
    if (isHost() && S.pending.length) {
      const r = S.pending[0];
      out.push(`<div class="alert ask"><p><b>${esc(nameOf(r.pid))}</b> wants to add <b>${fmt(r.amount)}</b>${r.note ? `<small>${esc(r.note)}</small>` : ''}${S.pending.length > 1 ? `<small>${S.pending.length - 1} more waiting</small>` : ''}</p>
        <div><button class="btn ghost sm" data-act="buyin-decide" data-id="${r.id}" data-ok="0">Decline</button><button class="btn gold sm" data-act="buyin-decide" data-id="${r.id}" data-ok="1">Approve</button></div></div>`);
    }
    const mine = S.pending.find((r) => r.pid === m.id);
    if (mine && !isHost()) {
      out.push(`<div class="alert"><p>Waiting for ${esc(nameOf(S.hostId))} to approve your <b>${fmt(mine.amount)}</b></p><div><button class="btn ghost sm" data-act="buyin-cancel">Cancel</button></div></div>`);
    }
    if (!isHost() && S.hostOfflineSince && Date.now() + S.skew - S.hostOfflineSince > 20000) {
      out.push(`<div class="alert"><p>${esc(nameOf(S.hostId))}, the host, is offline.</p><div><button class="btn gold sm" data-act="host-claim">Take over as host</button></div></div>`);
    }
    return out.join('');
  }

  /* ------------------------------------------------------- poker: felt */
  function nextDealerId() {
    const elig = S.players.filter((p) => !p.sittingOut && !p.left && p.stack > 0).map((p) => p.id);
    if (!elig.length) return null;
    if (S.nextDealerId && elig.includes(S.nextDealerId)) return S.nextDealerId;
    const all = S.players.map((p) => p.id);
    const i = all.indexOf(S.dealerId);
    if (i < 0) return elig[0];
    for (let k = 1; k <= all.length; k++) { const id = all[(i + k) % all.length]; if (elig.includes(id)) return id; }
    return null;
  }

  const STREET = {
    preflop: ['Pre-flop', 'Deal two cards each', 0],
    flop: ['Flop', 'Deal the flop', 3],
    turn: ['Turn', 'Deal the turn', 4],
    river: ['River', 'Deal the river', 5],
    showdown: ['Showdown', 'Show your cards', 5],
  };

  function pokerFeltHTML() {
    const h = S.hand;
    const my = session.playerId;
    const seats = S.players.filter((p) => !p.left || (h && h.seats[p.id]));
    const n = seats.length;
    const myIdx = Math.max(0, seats.findIndex((p) => p.id === my));
    const dealer = h ? h.dealerId : nextDealerId();
    let pods = '';
    seats.forEach((p, i) => {
      const k = (i - myIdx + n) % n;
      const ang = Math.PI / 2 + (2 * Math.PI * k) / n;
      const x = 50 + Math.cos(ang) * 37.5, y = 50 + Math.sin(ang) * 41.5;
      // Bet chips sit just inside the seat, toward the middle of the table.
      const ix = -Math.cos(ang), iy = -Math.sin(ang);
      const reach = (hw, hh) => Math.min(hw / (Math.abs(ix) || 1e-6), hh / (Math.abs(iy) || 1e-6));
      const off = reach(n >= 9 ? 36 : 43, 27) + reach(24, 13) + 3;
      const seat = h && h.seats[p.id];
      const cls = ['pod'];
      if (n >= 9) cls.push('tight');
      if (p.id === my) cls.push('me');
      if (h && h.toActId === p.id) cls.push('acting');
      if (seat && seat.folded) cls.push('folded');
      if (h && !seat) cls.push('idle');
      if (!h && (p.sittingOut || p.stack <= 0)) cls.push('idle');
      if (!p.connected) cls.push('off');
      let tag = '';
      if (seat && seat.allIn && !seat.folded) tag = '<em class="tag hot">All-in</em>';
      else if (seat && seat.folded) tag = '<em class="tag">Folded</em>';
      else if (p.left) tag = '<em class="tag">Left</em>';
      else if (p.sittingOut) tag = '<em class="tag">Sitting out</em>';
      else if (!seat && p.stack <= 0) tag = '<em class="tag">No chips</em>';
      const marks = [];
      if (dealer === p.id) marks.push('<i class="mark d" title="Dealer button">D</i>');
      if (h && h.sbId === p.id && h.street === 'preflop') marks.push('<i class="mark">SB</i>');
      if (h && h.bbId === p.id && h.street === 'preflop') marks.push('<i class="mark">BB</i>');
      pods += `<button class="${cls.join(' ')}" style="left:${x.toFixed(2)}%;top:${y.toFixed(2)}%" data-act="seat" data-pid="${p.id}">
        <span class="pod-name">${S.hostId === p.id ? '<i class="crown" title="Host"></i>' : ''}${esc(p.name)}</span>
        <span class="pod-stack">${fmt(p.stack)}</span>${tag}<span class="marks">${marks.join('')}</span></button>`;
      if (seat && seat.bet > 0) pods += `<span class="bet" style="left:calc(${x.toFixed(2)}% + ${(ix * off).toFixed(0)}px);top:calc(${y.toFixed(2)}% + ${(iy * off).toFixed(0)}px)"><i class="chip"></i>${fmt(seat.bet)}</span>`;
    });

    let center;
    if (h) {
      const [label, hint, lit] = STREET[h.street];
      const pot = h.street === 'showdown' ? h.pots.filter((p) => !p.awarded).reduce((s, p) => s + p.amount, 0) : h.potTotal;
      const cards = [0, 1, 2, 3, 4].map((i) => `<i class="card ${i < lit ? 'lit' : ''}"></i>`).join('');
      center = `<div class="street">${label}</div><div class="board">${cards}</div>
        <div class="pot"><small>Pot</small>${fmt(pot)}</div>
        <div class="hint">${h.street === 'showdown' && h.runout ? 'All-in: deal out the board' : hint}</div>`;
    } else if (S.lastResult && S.lastResult.winners.length) {
      const w = S.lastResult.winners;
      center = `<div class="street">Hand ${S.lastResult.handNo}</div>
        <div class="won">${w.map((x) => `<span><b>${esc(x.name)}</b> takes ${fmt(x.amount)}</span>`).join('')}</div>
        <div class="hint">Pass the button and shuffle up</div>`;
    } else {
      center = `<div class="street">Hand ${S.handNo + 1}</div><div class="hint">${n < 2 ? 'Share the table code so friends can sit down' : 'Shuffle up'}</div>`;
    }
    return `<div class="ring ${n >= 7 ? 'crowd' : ''}"><div class="rail"><div class="cloth"><div class="line"></div></div></div><div class="hub">${center}</div>${pods}</div>`;
  }

  /* ------------------------------------------------------- poker: dock */
  function actingAs() {
    const h = S.hand;
    if (ui.actFor && isHost() && h && h.toActId === ui.actFor) return ui.actFor;
    ui.actFor = null;
    return session.playerId;
  }

  function raiseCtx() {
    const h = S.hand, pid = actingAs(), seat = h.seats[pid], p = P(pid);
    if (!seat || !p) return null;
    const toCall = Math.max(0, r2(h.currentBet - seat.bet));
    const maxTo = r2(seat.bet + p.stack);
    const minTo = Math.min(maxTo, r2(h.currentBet + h.lastRaise));
    return { pid, seat, p, toCall, maxTo, minTo, cur: h.currentBet, pot: h.potTotal, opening: h.currentBet === 0,
      canRaise: !seat.raiseLocked && maxTo > h.currentBet, step: Math.max(1, S.settings.smallBlind) };
  }
  const snapRaise = (v, c) => {
    if (v >= c.maxTo - c.step / 2) return c.maxTo;
    return Math.max(c.minTo, Math.min(c.maxTo, Math.round(v / c.step) * c.step));
  };
  const CURVE = 1.8; // slider is finer at small bets

  function syncRaise() {
    const slider = $('#raise-slider');
    if (!slider) return;
    const c = raiseCtx();
    if (!c) return;
    ui.raiseTo = snapRaise(ui.raiseTo || c.minTo, c);
    const span = c.maxTo - c.minTo;
    slider.value = span > 0 ? Math.round(Math.pow((ui.raiseTo - c.minTo) / span, 1 / CURVE) * 1000) : 1000;
    paintRaise(c);
  }
  function paintRaise(c) {
    const v = ui.raiseTo;
    const out = $('#raise-val'), go = $('#raise-go'), slider = $('#raise-slider');
    if (out) out.textContent = fmt(v);
    if (go) go.textContent = v >= c.maxTo ? `All-in ${fmt(v)}` : `${c.opening ? 'Bet' : 'Raise to'} ${fmt(v)}`;
    if (slider) slider.style.setProperty('--fill', (slider.value / 10) + '%');
  }

  function pokerDockHTML() {
    const h = S.hand, m = me();
    const tools = `<div class="dock-tools">
        <button class="btn ghost sm" data-act="buyin">Add chips</button>
        <button class="btn ghost sm" data-act="sitout">${m.sittingOut ? "I'm back in" : 'Sit out'}</button>
      </div>`;

    if (!h) {
      const ready = S.players.filter((p) => !p.sittingOut && !p.left && p.stack > 0).length >= 2;
      const lead = isHost()
        ? `<button class="btn gold wide big" data-act="p-start" ${ready ? '' : 'disabled'}>${ready ? `Deal hand ${S.handNo + 1}` : 'Waiting for two players with chips'}</button>`
        : `<p class="dock-wait">${ready ? `Waiting for <b>${esc(nameOf(S.hostId))}</b> to deal` : 'Waiting for two players with chips'}</p>`;
      const broke = m.stack <= 0 ? '<p class="dock-note">You are out of chips. Add chips to play the next hand.</p>' : '';
      return lead + broke + tools;
    }

    if (h.street === 'showdown') return showdownHTML();

    const pid = actingAs();
    const myTurn = h.toActId === pid;
    if (!myTurn) {
      const mySeat = h.seats[m.id];
      const status = !mySeat ? 'You are dealt in from the next hand.' : mySeat.folded ? 'You folded this hand.' : mySeat.allIn ? 'You are all-in.' : '';
      return `<p class="dock-wait">Waiting for <b>${esc(nameOf(h.toActId))}</b></p>
        ${status ? `<p class="dock-note">${status}</p>` : ''}
        ${isHost() ? `<div class="dock-tools"><button class="btn ghost sm" data-act="p-actfor">Act for ${esc(nameOf(h.toActId))}</button></div>` : ''}`;
    }

    const c = raiseCtx();
    const forOther = pid !== m.id ? `<p class="dock-note">Acting for <b>${esc(nameOf(pid))}</b> <button class="link" data-act="p-actfor-stop">stop</button></p>` : '';
    const callAll = c.toCall >= c.p.stack;
    const callBtn = c.toCall > 0
      ? `<button class="btn green" data-act="p-call">${callAll ? `All-in ${fmt(c.p.stack)}` : `Call ${fmt(c.toCall)}`}</button>`
      : '<button class="btn green" data-act="p-check">Check</button>';

    if (ui.raiseOpen && c.canRaise) {
      const q = (label, v) => `<button class="q" data-act="p-quick" data-v="${v}">${label}</button>`;
      const frac = (f) => c.cur + Math.round(f * (c.pot + c.toCall));
      return `${forOther}
        <div class="raise">
          <div class="amount"><button class="step" data-act="p-step" data-d="-1" aria-label="Less">−</button><output id="raise-val"></output><button class="step" data-act="p-step" data-d="1" aria-label="More">+</button></div>
          <input type="range" id="raise-slider" class="slider" min="0" max="1000" step="1" data-input="raise" aria-label="Bet size">
          <div class="quick">${q('Min', c.minTo)}${q('½ pot', frac(0.5))}${q('¾ pot', frac(0.75))}${q('Pot', frac(1))}${q('All-in', c.maxTo)}</div>
        </div>
        <div class="actions two"><button class="btn ghost" data-act="p-raise-close">Back</button><button class="btn gold" id="raise-go" data-act="p-raise-go"></button></div>`;
    }
    ui.raiseOpen = false;
    const raiseBtn = !c.canRaise ? '' : c.minTo >= c.maxTo
      ? `<button class="btn gold" data-act="p-allin">All-in ${fmt(c.maxTo)}</button>`
      : `<button class="btn gold" data-act="p-raise-open">${c.opening ? 'Bet' : 'Raise'}</button>`;
    return `${forOther}<p class="dock-turn">${pid === m.id ? 'Your turn' : esc(nameOf(pid)) + ' to act'}${c.toCall > 0 ? ` — ${fmt(c.toCall)} to call` : ''}</p>
      <div class="actions ${raiseBtn ? 'three' : 'two'}"><button class="btn red" data-act="p-fold">Fold</button>${callBtn}${raiseBtn}</div>`;
  }

  function showdownHTML() {
    const h = S.hand, m = me(), host = isHost();
    const open = h.pots.map((p, i) => ({ ...p, i })).filter((p) => !p.awarded);
    const multi = h.pots.filter((p) => p.eligible.length > 1).length > 1;
    let html = `<p class="dock-turn">${host ? 'Tap who won' : 'Showdown'}</p>`;
    let sideNo = 0;
    h.pots.forEach((p, i) => {
      if (p.eligible.length <= 1 && p.awarded) return; // returned uncalled bet
      const title = !multi ? 'Pot' : sideNo++ === 0 ? 'Main pot' : `Side pot${sideNo > 2 ? ' ' + (sideNo - 1) : ''}`;
      if (p.awarded) { html += `<div class="potrow done"><span>${title} ${fmt(p.amount)}</span><b>${p.winners.map((w) => esc(nameOf(w))).join(' & ')}</b></div>`; return; }
      const sel = ui.awardSel[i] || [];
      const pills = p.eligible.map((id) => `<button class="pill ${sel.includes(id) ? 'on' : ''}" ${host ? `data-act="p-pick" data-pot="${i}" data-pid="${id}"` : 'disabled'}>${esc(nameOf(id))}</button>`).join('');
      let go = '';
      if (host) {
        const label = sel.length === 0 ? `Award ${fmt(p.amount)}` : sel.length === 1 ? `Pay ${esc(nameOf(sel[0]))} ${fmt(p.amount)}` : `Split ${fmt(p.amount)} ${sel.length} ways`;
        go = `<button class="btn gold" data-act="p-award" data-pot="${i}" ${sel.length ? '' : 'disabled'}>${label}</button>`;
      } else if (S.settings.playersCanClaim && p.eligible.includes(m.id)) {
        go = `<button class="btn gold" data-act="p-claim" data-pot="${i}">I won this — take ${fmt(p.amount)}</button>`;
      }
      html += `<div class="potrow"><span>${title} <b>${fmt(p.amount)}</b></span><div class="pills">${pills}</div>${go}</div>`;
    });
    if (!open.length) html += '<p class="dock-note">All pots paid.</p>';
    return html;
  }

  /* -------------------------------------------------- blackjack: felt */
  function bjFeltHTML() {
    const bj = S.bj, m = me();
    const dealerView = bj.dealerId === m.id || (isHost() && ui.dealerTools);
    const dealer = P(bj.dealerId);
    const bank = S.settings.bankMode === 'dealer'
      ? `Banking from own stack: <b>${fmt(dealer ? dealer.stack : 0)}</b>`
      : bj.house === 0 ? 'House is even' : `House ${bj.house > 0 ? 'is up' : 'is down'} <b>${fmt(Math.abs(bj.house))}</b>`;
    const RES = { win: 'Win', blackjack: 'Blackjack', push: 'Push', lose: 'Lose' };
    let rows = '';
    for (const p of S.players) {
      if (p.left || p.id === bj.dealerId) continue;
      const hands = bj.hands.filter((x) => x.pid === p.id);
      let body;
      if (!hands.length) {
        body = `<div class="bj-none">${bj.phase === 'betting' ? 'No bet yet' : 'Not in this round'}</div>`;
      } else {
        body = hands.map((x, i) => {
          const tags = (x.doubled ? '<em class="tag hot">Doubled</em>' : '') + (x.split ? `<em class="tag">Split ${i + 1}</em>` : '');
          const res = x.result ? `<span class="res ${x.result}">${RES[x.result]}${x.result !== 'push' ? ' ' + signed(x.net) : ''}</span>` : '';
          const btns = dealerView && bj.phase === 'playing'
            ? `<div class="settle">${['win', 'blackjack', 'push', 'lose'].map((k) => `<button class="${k} ${x.result === k ? 'on' : ''}" data-act="bj-resolve" data-id="${x.id}" data-r="${k}">${k === 'blackjack' ? (S.settings.bjPayout === 1.5 ? 'BJ 3:2' : 'BJ 6:5') : RES[k]}</button>`).join('')}</div>`
            : '';
          return `<div class="bj-hand ${x.result || ''}"><span class="bet static"><i class="chip"></i>${fmt(x.bet)}</span>${tags}${res}${btns}</div>`;
        }).join('');
      }
      rows += `<div class="bj-row ${p.id === m.id ? 'me' : ''} ${p.connected ? '' : 'off'}">
        <button class="bj-who" data-act="seat" data-pid="${p.id}"><span class="pod-name">${S.hostId === p.id ? '<i class="crown"></i>' : ''}${esc(p.name)}</span><span class="pod-stack">${fmt(p.stack)}</span></button>
        <div class="bj-hands">${body}</div></div>`;
    }
    if (!rows) rows = '<p class="bj-empty">Share the table code so players can sit down.</p>';
    const pays = S.settings.bjPayout === 1.5 ? 'Blackjack pays 3 to 2' : 'Blackjack pays 6 to 5';
    return `<div class="bj-table">
      <div class="bj-dealer">
        <svg class="arc" viewBox="0 0 320 70" aria-hidden="true"><path id="arc" d="M14 16 Q160 86 306 16" fill="none"/><text><textPath href="#arc" startOffset="50%" text-anchor="middle">${pays}</textPath></text></svg>
        <button class="dealer-plate" data-act="seat" data-pid="${bj.dealerId}"><span>Dealer</span><b>${esc(nameOf(bj.dealerId))}</b></button>
        <p class="bank">${bank}</p>
        <p class="round">Round ${bj.round} — ${bj.phase === 'betting' ? 'place your bets' : 'cards are out'}</p>
      </div>
      <div class="bj-rows">${rows}</div></div>`;
  }

  /* -------------------------------------------------- blackjack: dock */
  function bjLimits() {
    const m = me();
    const mine = S.bj.hands.find((x) => x.pid === m.id);
    const avail = r2(m.stack + (mine ? mine.bet : 0));
    const min = S.settings.minBet, max = Math.floor(Math.min(S.settings.maxBet, avail));
    return { mine, min, max, can: max >= min };
  }
  function syncBjBet() {
    const slider = $('#bj-slider');
    if (!slider) return;
    const L = bjLimits();
    if (!ui.bjBet) ui.bjBet = L.mine ? L.mine.bet : Math.min(L.max, S.bj.lastBets[me().id] || L.min);
    ui.bjBet = Math.max(L.min, Math.min(L.max, ui.bjBet));
    slider.value = ui.bjBet;
    paintBjBet(L);
  }
  function paintBjBet(L) {
    const out = $('#bj-val'), go = $('#bj-go'), slider = $('#bj-slider');
    if (out) out.textContent = fmt(ui.bjBet);
    if (go) go.textContent = L.mine ? (L.mine.bet === ui.bjBet ? `Bet placed: ${fmt(ui.bjBet)}` : `Change bet to ${fmt(ui.bjBet)}`) : `Place bet ${fmt(ui.bjBet)}`;
    if (go) go.disabled = !!(L.mine && L.mine.bet === ui.bjBet);
    if (slider) slider.style.setProperty('--fill', (L.max > L.min ? ((ui.bjBet - L.min) / (L.max - L.min)) * 100 : 100) + '%');
  }

  function bjDockHTML() {
    const bj = S.bj, m = me();
    const amDealer = bj.dealerId === m.id;
    const hostToggle = isHost() && !amDealer
      ? `<button class="btn ghost sm" data-act="bj-tools">${ui.dealerTools ? 'Hide dealer controls' : 'Dealer controls'}</button>` : '';
    let html = '';

    if (amDealer || (isHost() && ui.dealerTools)) {
      if (bj.phase === 'betting') {
        const seats = S.players.filter((p) => !p.left && p.id !== bj.dealerId).length;
        html += `<p class="dock-turn">${bj.hands.length} of ${seats} ${seats === 1 ? 'player has' : 'players have'} bet</p>
          <button class="btn gold wide big" data-act="bj-deal" ${bj.hands.length ? '' : 'disabled'}>Close bets and deal</button>`;
      } else {
        const open = bj.hands.filter((x) => !x.result).length;
        html += `<p class="dock-turn">${open ? `${open} ${open === 1 ? 'hand' : 'hands'} to settle — tap a result on each, or settle the rest together` : 'Every hand is settled'}</p>
          <div class="actions three"><button class="btn green" data-act="bj-all" data-r="win" ${open ? '' : 'disabled'}>Rest win</button><button class="btn ghost" data-act="bj-all" data-r="push" ${open ? '' : 'disabled'}>Rest push</button><button class="btn red" data-act="bj-all" data-r="lose" ${open ? '' : 'disabled'}>Rest lose</button></div>
          <button class="btn gold wide" data-act="bj-next" ${open ? 'disabled' : ''}>Next round</button>`;
      }
      if (amDealer) return html + `<div class="dock-tools"><button class="btn ghost sm" data-act="buyin">Add chips</button></div>`;
      html += '<hr class="dock-rule">';
    }

    if (bj.phase === 'betting') {
      const L = bjLimits();
      if (!L.can) {
        html += `<p class="dock-wait">${m.stack <= 0 ? 'You are out of chips.' : `You need at least ${fmt(L.min)} to bet.`}</p>`;
      } else {
        const denoms = [5, 10, 25, 50, 100, 250, 500, 1000].filter((d) => d >= L.min && d <= L.max).slice(0, 4);
        const last = bj.lastBets[m.id];
        html += `<div class="raise">
            <div class="amount"><button class="step" data-act="bj-step" data-d="-1" aria-label="Less">−</button><output id="bj-val"></output><button class="step" data-act="bj-step" data-d="1" aria-label="More">+</button></div>
            <input type="range" id="bj-slider" class="slider" min="${L.min}" max="${L.max}" step="${Math.max(1, Math.min(L.min, 5))}" data-input="bj" aria-label="Bet size">
            <div class="quick">${denoms.map((d) => `<button class="q" data-act="bj-add" data-v="${d}">+${fmt(d)}</button>`).join('')}${last ? `<button class="q" data-act="bj-set" data-v="${last}">Same again</button>` : ''}<button class="q" data-act="bj-set" data-v="${L.max}">Max</button></div>
          </div>
          <div class="actions ${L.mine ? 'two' : 'one'}">${L.mine ? '<button class="btn ghost" data-act="bj-clear">Take bet back</button>' : ''}<button class="btn gold" id="bj-go" data-act="bj-bet"></button></div>`;
      }
    } else {
      const mine = bj.hands.filter((x) => x.pid === m.id);
      if (!mine.length) html += '<p class="dock-wait">You are not in this round.</p>';
      else {
        html += mine.map((x, i) => {
          const label = mine.length > 1 ? `Hand ${i + 1}` : 'Your hand';
          if (x.result) return `<div class="potrow done"><span>${label}</span><b class="res ${x.result}">${{ win: 'Win', blackjack: 'Blackjack', push: 'Push', lose: 'Lose' }[x.result]} ${signed(x.net)}</b></div>`;
          const canDouble = !x.doubled && m.stack >= x.base;
          const canSplit = !x.doubled && m.stack >= x.base && mine.length < 4;
          return `<div class="potrow"><span>${label} <b>${fmt(x.bet)}</b></span>
            <div class="actions two"><button class="btn ghost" data-act="bj-double" data-id="${x.id}" ${canDouble ? '' : 'disabled'}>${x.doubled ? 'Doubled' : `Double +${fmt(x.base)}`}</button><button class="btn ghost" data-act="bj-split" data-id="${x.id}" ${canSplit ? '' : 'disabled'}>Split +${fmt(x.base)}</button></div></div>`;
        }).join('');
      }
    }
    return html + `<div class="dock-tools"><button class="btn ghost sm" data-act="buyin">Add chips</button>${hostToggle}</div>`;
  }

  /* -------------------------------------------------------------- sheets */
  function openSheet(name, props) { ui.sheet = { name, props: props || {} }; renderSheet(true); }
  function closeSheet() { ui.sheet = null; const r = $('#sheet-root'); if (r) { r._html = null; r.innerHTML = ''; } }
  function renderSheet(force) {
    if (!ui.sheet) return;
    const def = SHEETS[ui.sheet.name];
    if (!force && !def.live) return;
    const body = S ? def.html(ui.sheet.props) : '';
    if (!body) return closeSheet();
    const changed = setHTML($('#sheet-root'), `<div class="backdrop" data-act="sheet-close"></div><section class="sheet" role="dialog" aria-modal="true"><div class="grab"></div>${body}</section>`);
    if (changed && force) { const inp = $('#sheet-root [autofocus]'); if (inp) setTimeout(() => inp.focus(), 60); }
  }
  const joinLink = () => `${location.origin}/?room=${S.code}`;

  const SHEETS = {
    menu: {
      live: true,
      html() {
        const m = me(), host = isHost();
        const item = (act, label, sub, cls) => `<button class="item ${cls || ''}" data-act="${act}"><b>${label}</b>${sub ? `<small>${sub}</small>` : ''}</button>`;
        return `<h2>Table ${esc(S.code)}</h2><div class="items">
          ${item('buyin', 'Add chips', 'Type an amount, or scan chips, coins and notes')}
          ${item('share', 'Invite players', 'Code, link and QR')}
          ${item('ledger', 'Who is up, who is down', 'Buy-ins, stacks and results')}
          ${item('log', 'What happened', 'Every action this session')}
          ${S.mode === 'poker' ? item('sitout', m.sittingOut ? "I'm back in" : 'Sit out', m.sittingOut ? 'Deal me in next hand' : 'Skip hands until I am back') : ''}
          ${item('rename', 'Change my name', esc(m.name))}
          ${host ? `<h3>Host</h3>
            ${item('players', 'Players and seats', 'Seat order, stacks, button, remove')}
            ${item('settings', 'Table settings', S.mode === 'poker' ? `Blinds ${fmt(S.settings.smallBlind)}/${fmt(S.settings.bigBlind)}` : `Bets ${fmt(S.settings.minBet)}–${fmt(S.settings.maxBet)}`)}
            ${item('undo', 'Undo last action', S.canUndo ? 'Rewinds bets and payouts one step' : 'Nothing to undo yet', S.canUndo ? '' : 'dim')}
            ${S.hand ? item('abort', 'Cancel this hand', 'Misdeal: everyone gets their chips back') : ''}` : ''}
          ${item('leave', 'Leave table', '', 'danger')}
        </div>`;
      },
    },
    share: {
      html() {
        const link = joinLink();
        return `<h2>Invite players</h2>
          <div class="share"><div class="digits">${S.code.split('').map((d) => `<b>${d}</b>`).join('')}</div>
          <img class="qr" src="/qr.svg?u=${encodeURIComponent(link)}" alt="QR code to join this table" width="190" height="190">
          <p class="fine center">${esc(link)}</p></div>
          <div class="actions two"><button class="btn ghost" data-act="copy-link">Copy link</button><button class="btn gold" data-act="share-link">Share</button></div>`;
      },
    },
    ledger: {
      live: true,
      html() {
        const rows = S.players.filter((p) => !p.left).map((p) => `<tr><td>${esc(p.name)}</td><td>${fmt(p.buyIn)}</td><td>${fmt(p.stack)}</td><td class="${p.stack - p.buyIn >= 0 ? 'up' : 'down'}">${signed(r2(p.stack - p.buyIn))}</td></tr>`).join('');
        const gone = S.cashedOut.map((p) => `<tr class="gone"><td>${esc(p.name)} (left)</td><td>${fmt(p.buyIn)}</td><td>${fmt(p.stack)}</td><td class="${p.stack - p.buyIn >= 0 ? 'up' : 'down'}">${signed(r2(p.stack - p.buyIn))}</td></tr>`).join('');
        const house = S.mode === 'blackjack' && S.settings.bankMode === 'house' ? `<tr class="gone"><td>House</td><td></td><td></td><td class="${S.bj.house >= 0 ? 'up' : 'down'}">${signed(S.bj.house)}</td></tr>` : '';
        const inPlay = S.hand ? `<p class="fine">${fmt(S.hand.potTotal)} is in the pot right now, so results settle when the hand ends.</p>` : '';
        return `<h2>Who is up, who is down</h2>
          <table class="ledger"><thead><tr><th>Player</th><th>Bought in</th><th>Stack</th><th>Result</th></tr></thead><tbody>${rows}${gone}${house}</tbody></table>${inPlay}
          <p class="fine">Result is stack minus buy-ins. Use it to settle up at the end of the night.</p>`;
      },
    },
    log: {
      live: true,
      html() {
        const t = (ms) => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        return `<h2>What happened</h2><ol class="log">${S.log.slice().reverse().map((l) => `<li><time>${t(l.t)}</time>${esc(l.msg)}</li>`).join('')}</ol>`;
      },
    },
    buyin: {
      html() {
        const base = S.settings.startingStack || (S.mode === 'poker' ? S.settings.bigBlind * 100 : S.settings.minBet * 50);
        const quick = [...new Set([Math.round(base / 2), base, base * 2])].filter((v) => v > 0);
        const approve = S.settings.approveBuyins && !isHost();
        return `<h2>Add chips</h2>
          <label class="field"><span>Amount</span><input id="buyin-amt" inputmode="${S.mode === 'poker' ? 'numeric' : 'decimal'}" placeholder="0" autofocus></label>
          <div class="quick">${quick.map((v) => `<button class="q" data-act="buyin-quick" data-v="${v}">${fmt(v)}</button>`).join('')}</div>
          <button class="btn gold wide" data-act="buyin-go">${approve ? 'Ask the host to add it' : 'Add to my stack'}</button>
          <div class="or"><span>or count what is on the table</span></div>
          <button class="btn ghost wide" data-act="scan">Scan chips, coins or notes</button>
          <p class="fine">${approve ? `${esc(nameOf(S.hostId))} approves every buy-in, so nobody can top up unnoticed.` : 'Buy-ins are added straight away and show up in the activity log.'}</p>`;
      },
    },
    players: {
      live: true,
      html() {
        if (!isHost()) return '';
        const rows = S.players.filter((p) => !p.left).map((p, i, arr) => `<div class="prow">
          <button class="pmain" data-act="seat" data-pid="${p.id}"><b>${esc(p.name)}</b><small>${fmt(p.stack)} chips${p.connected ? '' : ' — offline'}${S.hostId === p.id ? ' — host' : ''}</small></button>
          <button class="step" data-act="move" data-pid="${p.id}" data-d="-1" ${i === 0 ? 'disabled' : ''} aria-label="Move earlier">↑</button>
          <button class="step" data-act="move" data-pid="${p.id}" data-d="1" ${i === arr.length - 1 ? 'disabled' : ''} aria-label="Move later">↓</button></div>`).join('');
        return `<h2>Players and seats</h2><p class="fine">${S.mode === 'poker' ? 'List the players clockwise as they sit at the real table, so the button and blinds move the right way. ' : ''}Tap a player for more.</p>${rows}`;
      },
    },
    player: {
      live: true,
      html({ pid }) {
        const p = P(pid);
        if (!p || p.left || !isHost()) return '';
        const item = (act, label, sub, cls) => `<button class="item ${cls || ''}" data-act="${act}" data-pid="${p.id}"><b>${label}</b>${sub ? `<small>${sub}</small>` : ''}</button>`;
        return `<h2>${esc(p.name)}</h2><p class="fine">${fmt(p.stack)} chips, ${fmt(p.buyIn)} bought in${p.connected ? '' : ' — offline'}</p><div class="items">
          ${item('adjust', 'Add or remove chips', 'Buy-in, cash-out or a correction')}
          ${S.mode === 'poker' ? item('give-button', 'Give the button', 'This player deals the next hand') : ''}
          ${S.mode === 'blackjack' && S.bj.dealerId !== p.id ? item('make-dealer', 'Make dealer', 'Between rounds') : ''}
          ${p.id !== me().id ? item('make-host', 'Make host', 'Hand over the table controls') : ''}
          ${p.id !== me().id ? item('kick', 'Remove from table', '', 'danger') : ''}
        </div>`;
      },
    },
    adjust: {
      html({ pid }) {
        const p = P(pid);
        if (!p) return '';
        return `<h2>${esc(p.name)}'s chips</h2><p class="fine">Stack ${fmt(p.stack)}</p>
          <label class="field"><span>Amount</span><input id="adj-amt" inputmode="decimal" placeholder="0" autofocus></label>
          <div class="actions two"><button class="btn gold" data-act="adj-go" data-pid="${p.id}" data-sign="1" data-ledger="1">Buy in</button><button class="btn ghost" data-act="adj-go" data-pid="${p.id}" data-sign="-1" data-ledger="1">Cash out</button></div>
          <div class="or"><span>or fix a mistake without touching the ledger</span></div>
          <div class="actions two"><button class="btn ghost" data-act="adj-go" data-pid="${p.id}" data-sign="1" data-ledger="0">Correct: add</button><button class="btn ghost" data-act="adj-go" data-pid="${p.id}" data-sign="-1" data-ledger="0">Correct: take</button></div>`;
      },
    },
    settings: {
      html() {
        const s = S.settings;
        const num = (k, label) => `<label class="field"><span>${label}</span><input data-set="${k}" inputmode="numeric" value="${esc(s[k])}"></label>`;
        const tog = (k, label, sub) => `<label class="toggle"><input type="checkbox" data-set="${k}" ${s[k] ? 'checked' : ''}><span><b>${label}</b><small>${sub}</small></span></label>`;
        return `<h2>Table settings</h2>
          <div class="grid3">${S.mode === 'poker' ? num('smallBlind', 'Small blind') + num('bigBlind', 'Big blind') : num('minBet', 'Minimum bet') + num('maxBet', 'Maximum bet')}${num('startingStack', 'Starting stack')}</div>
          ${S.mode === 'blackjack' ? `<label class="field"><span>Blackjack pays</span><select data-set="bjPayout"><option value="1.5" ${s.bjPayout === 1.5 ? 'selected' : ''}>3 to 2</option><option value="1.2" ${s.bjPayout === 1.2 ? 'selected' : ''}>6 to 5</option></select></label>
            <label class="field"><span>Who pays the winners</span><select data-set="bankMode"><option value="house" ${s.bankMode === 'house' ? 'selected' : ''}>The house (a running tally)</option><option value="dealer" ${s.bankMode === 'dealer' ? 'selected' : ''}>The dealer's own stack</option></select></label>` : ''}
          ${tog('approveBuyins', 'Host approves buy-ins', 'Players ask, you confirm')}
          ${S.mode === 'poker' ? tog('playersCanClaim', 'Winners can take the pot', 'Otherwise only the host awards pots') : ''}
          <p class="fine">The starting stack applies to players who join from now on.</p>
          <button class="btn gold wide" data-act="settings-save">Save settings</button>`;
      },
    },
    rename: {
      html() { return `<h2>Change my name</h2><label class="field"><span>Name</span><input id="rename" maxlength="16" value="${esc(me().name)}" autofocus></label><button class="btn gold wide" data-act="rename-go">Save name</button>`; },
    },
    confirm: {
      html({ title, text, yes, act, pid }) {
        return `<h2>${esc(title)}</h2><p class="fine">${esc(text)}</p><div class="actions two"><button class="btn ghost" data-act="sheet-close">Keep playing</button><button class="btn red" data-act="${act}" data-pid="${pid || ''}">${esc(yes)}</button></div>`;
      },
    },
  };

  /* ------------------------------------------------------------- actions */
  const val = (sel) => { const el = $(sel); return el ? el.value.trim() : ''; };
  const amount = (sel) => Number(val(sel).replace(',', '.'));

  const A = {
    /* home */
    'home-mode'(el) { ui.homeMode = el.dataset.mode; render(); },
    join() {
      const name = (ui.form.name != null ? ui.form.name : ls.get('ts.name', '')).trim();
      const code = (ui.form.code != null ? ui.form.code : val('.code-input')).trim();
      if (!name) return toast('Enter your name first.', 'error');
      if (!/^\d{4}$/.test(code)) return toast('The table code has four digits.', 'error');
      ls.set('ts.name', name);
      socket.emit('room:join', { code, name }, enter);
    },
    host() {
      const name = (ui.form.name != null ? ui.form.name : ls.get('ts.name', '')).trim();
      if (!name) return toast('Enter your name first.', 'error');
      ls.set('ts.name', name);
      const f = ui.form, settings = {};
      for (const k of ['startingStack', 'smallBlind', 'bigBlind', 'minBet', 'maxBet']) if (f[k] != null && f[k] !== '') settings[k] = Number(f[k]);
      socket.emit('room:create', { name, mode: ui.homeMode, settings }, enter);
    },
    retry() { if (!socket.connected) socket.connect(); else rejoin(); },
    forget() { setSession(null); S = null; view = 'home'; history.replaceState(null, '', '/'); render(); },

    /* poker */
    'p-start'() { ui.awardSel = {}; send('poker.start'); },
    'p-fold'() { send('poker.act', { action: 'fold', forId: actingAs() }); },
    'p-check'() { send('poker.act', { action: 'check', forId: actingAs() }); },
    'p-call'() { send('poker.act', { action: 'call', forId: actingAs() }); },
    'p-allin'() { send('poker.act', { action: 'allin', forId: actingAs() }); },
    'p-raise-open'() { const c = raiseCtx(); ui.raiseTo = c.minTo; ui.raiseOpen = true; render(); },
    'p-raise-close'() { ui.raiseOpen = false; render(); },
    'p-raise-go'() {
      const c = raiseCtx();
      const to = snapRaise(ui.raiseTo, c);
      send('poker.act', { action: to >= c.maxTo ? 'allin' : 'raise', amount: to, forId: c.pid }, (r) => { if (r.ok) ui.raiseOpen = false; });
    },
    'p-step'(el) { const c = raiseCtx(); ui.raiseTo = snapRaise(ui.raiseTo + Number(el.dataset.d) * Math.max(c.step, S.settings.bigBlind), c); syncRaise(); },
    'p-quick'(el) { const c = raiseCtx(); ui.raiseTo = snapRaise(Number(el.dataset.v), c); syncRaise(); },
    'p-actfor'() { ui.actFor = S.hand && S.hand.toActId; ui.raiseOpen = false; render(); },
    'p-actfor-stop'() { ui.actFor = null; ui.raiseOpen = false; render(); },
    'p-pick'(el) {
      const i = el.dataset.pot, id = el.dataset.pid;
      const sel = ui.awardSel[i] || (ui.awardSel[i] = []);
      const k = sel.indexOf(id);
      if (k >= 0) sel.splice(k, 1); else sel.push(id);
      render();
    },
    'p-award'(el) { const i = el.dataset.pot; send('poker.award', { pot: Number(i), winners: ui.awardSel[i] || [] }, (r) => { if (r.ok) delete ui.awardSel[i]; }); },
    'p-claim'(el) { send('poker.award', { pot: Number(el.dataset.pot), winners: [session.playerId] }); },
    sitout() { send('me.sitout', { value: !me().sittingOut }); },

    /* blackjack */
    'bj-tools'() { ui.dealerTools = !ui.dealerTools; render(); },
    'bj-deal'() { send('bj.deal'); },
    'bj-resolve'(el) { const on = el.classList.contains('on'); send('bj.resolve', { handId: el.dataset.id, result: on ? null : el.dataset.r }); },
    'bj-all'(el) { send('bj.resolveAll', { result: el.dataset.r }); },
    'bj-next'() { ui.bjBet = 0; send('bj.newRound'); },
    'bj-bet'() { send('bj.bet', { amount: ui.bjBet }); },
    'bj-clear'() { send('bj.bet', { amount: 0 }); },
    'bj-step'(el) { const L = bjLimits(); ui.bjBet = Math.max(L.min, Math.min(L.max, ui.bjBet + Number(el.dataset.d) * L.min)); syncBjBet(); },
    'bj-add'(el) { const L = bjLimits(); ui.bjBet = Math.min(L.max, ui.bjBet + Number(el.dataset.v)); syncBjBet(); },
    'bj-set'(el) { const L = bjLimits(); ui.bjBet = Math.max(L.min, Math.min(L.max, Number(el.dataset.v))); syncBjBet(); },
    'bj-double'(el) { send('bj.double', { handId: el.dataset.id }); },
    'bj-split'(el) { send('bj.split', { handId: el.dataset.id }); },

    /* chips in */
    buyin() { openSheet('buyin'); },
    'buyin-quick'(el) { const i = $('#buyin-amt'); if (i) i.value = el.dataset.v; },
    'buyin-go'() {
      const a = amount('#buyin-amt');
      if (!(a > 0)) return toast('Enter how many chips to add.', 'error');
      send('buyin.request', { amount: a, note: '' }, (r) => { if (r.ok) { closeSheet(); toast(S.settings.approveBuyins && !isHost() ? 'Sent to the host for approval.' : `Added ${fmt(a)}.`); } });
    },
    'buyin-cancel'() { send('buyin.cancel'); },
    'buyin-decide'(el) { send('buyin.decide', { id: el.dataset.id, approve: el.dataset.ok === '1' }); },
    scan() {
      closeSheet();
      window.Scanner.open({
        whole: S.mode === 'poker',
        onDone({ amount: a, note }) {
          send('buyin.request', { amount: a, note }, (r) => { if (r.ok) toast(S.settings.approveBuyins && !isHost() ? 'Sent to the host for approval.' : `Added ${fmt(a)}.`); });
        },
      });
    },

    /* sheets and menu */
    menu() { openSheet('menu'); },
    'sheet-close'() { closeSheet(); },
    share() { openSheet('share'); },
    ledger() { openSheet('ledger'); },
    log() { openSheet('log'); },
    players() { openSheet('players'); },
    settings() { openSheet('settings'); },
    rename() { openSheet('rename'); },
    'rename-go'() { const name = val('#rename'); send('me.rename', { name }, (r) => { if (r.ok) { ls.set('ts.name', name); closeSheet(); } }); },
    async 'copy-link'() {
      try { await navigator.clipboard.writeText(joinLink()); toast('Link copied.'); } catch (e) { toast('Copy the link shown above.', 'warn'); }
    },
    async 'share-link'() {
      const data = { title: 'Table Stakes', text: `Join my ${S.mode} table — code ${S.code}`, url: joinLink() };
      if (navigator.share) { try { await navigator.share(data); } catch (e) { /* cancelled */ } } else A['copy-link']();
    },
    seat(el) { if (isHost()) openSheet('player', { pid: el.dataset.pid }); },
    adjust(el) { openSheet('adjust', { pid: el.dataset.pid }); },
    'adj-go'(el) {
      const a = amount('#adj-amt');
      if (!(a > 0)) return toast('Enter an amount.', 'error');
      send('host.adjust', { pid: el.dataset.pid, delta: a * Number(el.dataset.sign), ledger: el.dataset.ledger === '1' }, (r) => { if (r.ok) closeSheet(); });
    },
    move(el) { send('host.move', { pid: el.dataset.pid, dir: Number(el.dataset.d) }); },
    'give-button'(el) { send('poker.button', { pid: el.dataset.pid }, (r) => { if (r.ok) closeSheet(); }); },
    'make-dealer'(el) { send('bj.dealer', { pid: el.dataset.pid }, (r) => { if (r.ok) closeSheet(); }); },
    'make-host'(el) { send('host.transfer', { pid: el.dataset.pid }, (r) => { if (r.ok) closeSheet(); }); },
    kick(el) { openSheet('confirm', { title: `Remove ${nameOf(el.dataset.pid)}?`, text: 'Their stack is noted in the ledger as cashed out.', yes: 'Remove', act: 'kick-go', pid: el.dataset.pid }); },
    'kick-go'(el) { send('host.kick', { pid: el.dataset.pid }, () => closeSheet()); },
    'host-claim'() { send('host.claim'); },
    undo() { if (S.canUndo) send('host.undo', {}, (r) => { if (r.ok) { closeSheet(); toast('Undone.'); } }); },
    abort() { openSheet('confirm', { title: 'Cancel this hand?', text: 'Every bet goes back to its player and the button stays where it is.', yes: 'Cancel hand', act: 'abort-go' }); },
    'abort-go'() { send('poker.abort', {}, () => closeSheet()); },
    leave() { openSheet('confirm', { title: 'Leave the table?', text: 'Your stack is noted in the ledger as cashed out. If you are in a hand, you fold.', yes: 'Leave table', act: 'leave-go' }); },
    'leave-go'() { send('me.leave'); history.replaceState(null, '', '/'); },
    'settings-save'() {
      const settings = {};
      document.querySelectorAll('#sheet-root [data-set]').forEach((el) => { settings[el.dataset.set] = el.type === 'checkbox' ? el.checked : el.value; });
      for (const k of ['smallBlind', 'bigBlind', 'minBet', 'maxBet', 'startingStack', 'bjPayout']) if (k in settings) settings[k] = Number(settings[k]);
      send('host.settings', { settings }, (r) => { if (r.ok) { closeSheet(); ui.bjBet = 0; } });
    },
  };

  document.addEventListener('click', (e) => {
    const el = e.target.closest('[data-act]');
    if (!el || el.disabled) return;
    const fn = A[el.dataset.act];
    if (fn) { e.preventDefault(); fn(el, e); }
  });

  document.addEventListener('input', (e) => {
    const el = e.target;
    if (el.dataset.bind) {
      let v = el.value;
      if (el.dataset.bind === 'code') { v = v.replace(/\D/g, '').slice(0, 4); el.value = v; }
      ui.form[el.dataset.bind] = v;
      if (el.dataset.bind === 'name') ls.set('ts.name', v.trim());
    } else if (el.dataset.input === 'raise') {
      const c = raiseCtx();
      if (!c) return;
      const t = Number(el.value) / 1000;
      ui.raiseTo = snapRaise(c.minTo + (c.maxTo - c.minTo) * Math.pow(t, CURVE), c);
      paintRaise(c);
    } else if (el.dataset.input === 'bj') {
      ui.bjBet = Number(el.value);
      paintBjBet(bjLimits());
    }
  });

  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || e.target.tagName !== 'INPUT') return;
    const map = { 'buyin-amt': 'buyin-go', rename: 'rename-go' };
    if (e.target.dataset.bind === 'code') A.join();
    else if (map[e.target.id]) A[map[e.target.id]]();
  });

  // The "host is offline" notice depends on elapsed time, so refresh it now and then.
  setInterval(() => { if (view === 'table' && S && S.hostOfflineSince) setHTML($('#alerts'), alertsHTML()); }, 5000);

  window.TableStakes = { toast, fmt };
  render();
})();
