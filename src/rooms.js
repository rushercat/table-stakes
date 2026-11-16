'use strict';
/**
 * Rooms, seats, buy-ins, host tools and the action dispatcher.
 * All state lives in memory; the host's phone also keeps a backup so a table
 * survives a server restart (see RoomStore.restore).
 */
const poker = require('./poker');
const blackjack = require('./blackjack');
const { userError, r2, uid, num, cleanName, fmt } = require('./util');

const MAX_PLAYERS = 10;
const UNDO_DEPTH = 30;
const HOST_CLAIM_AFTER_MS = 20000;

const DEFAULTS = {
  poker: { startingStack: 1000, smallBlind: 5, bigBlind: 10, approveBuyins: true, playersCanClaim: true },
  blackjack: { startingStack: 1000, minBet: 10, maxBet: 500, bjPayout: 1.5, bankMode: 'house', approveBuyins: true },
};

function cleanSettings(mode, input, base) {
  const s = { ...base };
  const has = (k) => input && input[k] !== undefined && input[k] !== null && input[k] !== '';
  if (has('startingStack')) s.startingStack = num(input.startingStack, { min: 0, max: 1e7, int: true, name: 'Starting stack' });
  if (mode === 'poker') {
    if (has('smallBlind')) s.smallBlind = num(input.smallBlind, { min: 1, max: 1e6, int: true, name: 'Small blind' });
    if (has('bigBlind')) s.bigBlind = num(input.bigBlind, { min: 1, max: 1e6, int: true, name: 'Big blind' });
    if (s.bigBlind < s.smallBlind) throw userError('The big blind has to be at least the small blind.');
    if (has('playersCanClaim')) s.playersCanClaim = !!input.playersCanClaim;
  } else {
    if (has('minBet')) s.minBet = num(input.minBet, { min: 1, max: 1e6, int: true, name: 'Minimum bet' });
    if (has('maxBet')) s.maxBet = num(input.maxBet, { min: 1, max: 1e7, int: true, name: 'Maximum bet' });
    if (s.maxBet < s.minBet) throw userError('The maximum bet has to be at least the minimum bet.');
    if (has('bjPayout')) {
      const v = Number(input.bjPayout);
      if (v !== 1.5 && v !== 1.2) throw userError('Blackjack pays 3:2 or 6:5.');
      s.bjPayout = v;
    }
    if (has('bankMode')) {
      if (!['house', 'dealer'].includes(input.bankMode)) throw userError('Unknown bank setting.');
      s.bankMode = input.bankMode;
    }
  }
  if (has('approveBuyins')) s.approveBuyins = !!input.approveBuyins;
  return s;
}

class Room {
  constructor(code, mode) {
    this.code = code;
    this.mode = mode;
    this.settings = { ...DEFAULTS[mode] };
    this.hostId = null;
    this.players = [];
    this.dealerId = null;
    this.nextDealerId = null;
    this.handNo = 0;
    this.hand = null;
    this.lastResult = null;
    this.bj = null;
    this.pending = [];
    this.cashedOut = [];
    this.logs = [];
    this.logSeq = 0;
    this.undo = [];
    this.effects = [];
    this.createdAt = Date.now();
    this.lastActive = Date.now();
    this.hostOfflineSince = null;
  }

  log(msg) {
    this.logSeq += 1;
    this.logs.push({ id: this.logSeq, t: Date.now(), msg });
    if (this.logs.length > 120) this.logs.splice(0, this.logs.length - 120);
  }

  player(id) { return this.players.find((p) => p.id === id); }

  addPlayer(rawName) {
    if (this.players.filter((p) => !p.left).length >= MAX_PLAYERS) throw userError('This table is full.');
    let name = cleanName(rawName);
    const taken = (n) => this.players.some((p) => p.name.toLowerCase() === n.toLowerCase());
    if (taken(name)) {
      let i = 2;
      while (taken(`${name.slice(0, 14)} ${i}`)) i++;
      name = `${name.slice(0, 14)} ${i}`;
    }
    const stack = this.settings.startingStack;
    const p = { id: uid(6), token: uid(16), name, stack, buyIn: stack, connected: false, socketId: null, sittingOut: false, left: false };
    this.players.push(p);
    this.log(stack > 0 ? `${name} sat down with ${fmt(stack)}.` : `${name} sat down.`);
    return p;
  }

  /** Is this player still live in a poker hand (chips at risk)? */
  liveInHand(pid) {
    const h = this.hand;
    return !!(h && h.seats[pid] && !h.seats[pid].folded);
  }

  purgeLeft() {
    this.players = this.players.filter((p) => !p.left);
  }

  removePlayer(pid, verb) {
    const p = this.player(pid);
    if (!p || p.left) return;
    p.left = true;
    p.sittingOut = true;
    this.pending = this.pending.filter((r) => r.pid !== pid);
    const inHand = this.mode === 'poker' && this.hand && this.hand.seats[pid];
    if (this.mode === 'poker' && this.liveInHand(pid)) poker.forceFold(this, pid);
    if (this.mode === 'blackjack') blackjack.removePlayer(this, pid);
    this.cashedOut.push({ name: p.name, buyIn: p.buyIn, stack: p.stack, t: Date.now() });
    this.log(`${p.name} ${verb} with ${fmt(p.stack)}.`);
    if (p.socketId) this.effects.push({ type: 'removed', socketId: p.socketId, kicked: verb !== 'left' });
    p.connected = false;
    p.socketId = null;
    // Keep the seat on the felt until the current hand is over.
    if (!(inHand && this.hand)) this.purgeLeft();

    const remaining = this.players.filter((x) => !x.left);
    if (this.hostId === pid && remaining.length) {
      const next = remaining.find((x) => x.connected) || remaining[0];
      this.hostId = next.id;
      this.hostOfflineSince = next.connected ? null : Date.now();
      this.log(`${next.name} is the host now.`);
    }
    if (this.mode === 'blackjack' && this.bj.dealerId === pid && remaining.length) {
      blackjack.setDealerOnLeave(this);
    }
  }

  applyBuyIn(p, amount) {
    if (this.liveInHand(p.id)) throw userError('Chips can only be added between hands.');
    p.stack = r2(p.stack + amount);
    p.buyIn = r2(p.buyIn + amount);
  }

  snapshot() {
    return JSON.stringify({
      players: this.players, dealerId: this.dealerId, nextDealerId: this.nextDealerId, handNo: this.handNo,
      hand: this.hand, lastResult: this.lastResult, bj: this.bj, pending: this.pending, cashedOut: this.cashedOut,
      logs: this.logs, logSeq: this.logSeq,
    });
  }

  restoreSnapshot(json, { keepLogs = false, keepLive = true } = {}) {
    const s = JSON.parse(json);
    const cur = new Map(this.players.map((p) => [p.id, p]));
    const restored = s.players.map((sp) => {
      const c = cur.get(sp.id);
      return keepLive ? { ...sp, connected: c ? c.connected : false, socketId: c ? c.socketId : null, token: c ? c.token : sp.token, name: c ? c.name : sp.name } : sp;
    });
    // Anyone who sat down after the snapshot keeps their seat.
    for (const p of this.players) if (!s.players.some((sp) => sp.id === p.id)) restored.push(p);
    this.players = restored;
    this.dealerId = s.dealerId;
    this.nextDealerId = s.nextDealerId;
    this.handNo = s.handNo;
    this.hand = s.hand;
    this.lastResult = s.lastResult;
    this.bj = s.bj;
    this.pending = s.pending;
    this.cashedOut = s.cashedOut;
    if (!keepLogs) { this.logs = s.logs; this.logSeq = s.logSeq; }
    if (!this.player(this.hostId) && this.players.length) this.hostId = this.players[0].id;
  }

  publicState() {
    return {
      code: this.code, mode: this.mode, settings: this.settings, hostId: this.hostId,
      handNo: this.handNo, dealerId: this.dealerId, nextDealerId: this.nextDealerId,
      players: this.players.map((p) => ({ id: p.id, name: p.name, stack: p.stack, buyIn: p.buyIn, connected: p.connected, sittingOut: p.sittingOut, left: p.left })),
      hand: poker.publicHand(this.hand), lastResult: this.lastResult, bj: this.bj,
      pending: this.pending, cashedOut: this.cashedOut, log: this.logs.slice(-40),
      canUndo: this.undo.length > 0, hostOfflineSince: this.hostOfflineSince, now: Date.now(),
    };
  }

  /** Everything needed to rebuild this table on a fresh server. Sent to the host only. */
  backup() {
    return {
      v: 1, code: this.code, mode: this.mode, settings: this.settings, hostId: this.hostId, createdAt: this.createdAt,
      players: this.players.map((p) => ({ ...p, connected: false, socketId: null })),
      dealerId: this.dealerId, nextDealerId: this.nextDealerId, handNo: this.handNo, hand: this.hand,
      lastResult: this.lastResult, bj: this.bj, pending: this.pending, cashedOut: this.cashedOut,
      logs: this.logs.slice(-30), logSeq: this.logSeq,
    };
  }
}

/* ------------------------------------------------------------------ actions */

const UNDOABLE = new Set([
  'poker.start', 'poker.act', 'poker.award', 'poker.abort',
  'bj.bet', 'bj.deal', 'bj.double', 'bj.split', 'bj.resolve', 'bj.resolveAll', 'bj.newRound',
  'buyin.request', 'buyin.decide', 'host.adjust',
]);

function handle(room, me, msg) {
  const isHost = me.id === room.hostId;
  const needHost = (what = 'do that') => { if (!isHost) throw userError(`Only the host can ${what}.`); };
  const needMode = (mode) => { if (room.mode !== mode) throw userError('That does not work at this table.'); };
  const target = (id) => {
    const p = room.player(id);
    if (!p || p.left) throw userError('Player not found.');
    return p;
  };
  const amountOpts = { min: 1, max: 1e7, int: room.mode === 'poker' };

  switch (msg.type) {
    /* ---- poker ---- */
    case 'poker.start': needMode('poker'); needHost('deal a hand'); poker.startHand(room); break;
    case 'poker.act': {
      needMode('poker');
      let pid = me.id;
      if (msg.forId && msg.forId !== me.id) { needHost('act for another player'); pid = target(msg.forId).id; }
      poker.act(room, pid, String(msg.action), msg.amount);
      break;
    }
    case 'poker.award': {
      needMode('poker');
      const winners = Array.isArray(msg.winners) ? msg.winners.map(String) : [];
      const selfClaim = room.settings.playersCanClaim && winners.length === 1 && winners[0] === me.id;
      if (!isHost && !selfClaim) throw userError('Only the host can award this pot.');
      poker.award(room, Number(msg.pot), winners);
      break;
    }
    case 'poker.abort': needMode('poker'); needHost('cancel a hand'); poker.abort(room); break;
    case 'poker.button': {
      needMode('poker'); needHost('move the button');
      if (room.hand) throw userError('Move the button between hands.');
      const p = target(msg.pid);
      room.nextDealerId = p.id;
      room.log(`${p.name} gets the button next hand.`);
      break;
    }

    /* ---- blackjack ---- */
    case 'bj.bet': {
      needMode('blackjack');
      let pid = me.id;
      if (msg.forId && msg.forId !== me.id) {
        if (!isHost && me.id !== room.bj.dealerId) throw userError('Only the dealer can bet for another player.');
        pid = target(msg.forId).id;
      }
      const amount = msg.amount ? num(msg.amount, { min: 0, max: 1e7, int: true, name: 'Bet' }) : 0;
      blackjack.bet(room, pid, amount);
      break;
    }
    case 'bj.double':
    case 'bj.split': {
      needMode('blackjack');
      const h = room.bj.hands.find((x) => x.id === msg.handId);
      if (!h) throw userError('Hand not found.');
      if (h.pid !== me.id && !isHost && me.id !== room.bj.dealerId) throw userError('That is not your hand.');
      (msg.type === 'bj.double' ? blackjack.double : blackjack.split)(room, h.id);
      break;
    }
    case 'bj.deal':
    case 'bj.resolve':
    case 'bj.resolveAll':
    case 'bj.newRound': {
      needMode('blackjack');
      if (!isHost && me.id !== room.bj.dealerId) throw userError('Only the dealer can do that.');
      if (msg.type === 'bj.deal') blackjack.deal(room);
      else if (msg.type === 'bj.resolve') blackjack.resolve(room, String(msg.handId), msg.result || null);
      else if (msg.type === 'bj.resolveAll') blackjack.resolveAll(room, String(msg.result));
      else blackjack.newRound(room);
      break;
    }
    case 'bj.dealer': needMode('blackjack'); needHost('pick the dealer'); blackjack.setDealer(room, target(msg.pid).id); break;

    /* ---- chips in and out ---- */
    case 'buyin.request': {
      const amount = num(msg.amount, { ...amountOpts, name: 'Buy-in' });
      const note = String(msg.note || '').replace(/[\u0000-\u001f<>]/g, '').slice(0, 90);
      if (isHost || !room.settings.approveBuyins) {
        room.applyBuyIn(me, amount);
        room.log(`${me.name} adds ${fmt(amount)}${note ? ` (${note})` : ''}.`);
      } else {
        room.pending = room.pending.filter((r) => r.pid !== me.id);
        room.pending.push({ id: uid(4), pid: me.id, name: me.name, amount, note, t: Date.now() });
        room.log(`${me.name} asks to add ${fmt(amount)}.`);
      }
      break;
    }
    case 'buyin.cancel': room.pending = room.pending.filter((r) => r.pid !== me.id); break;
    case 'buyin.decide': {
      needHost('approve buy-ins');
      const req = room.pending.find((r) => r.id === msg.id);
      if (!req) throw userError('That request is gone.');
      const p = room.player(req.pid);
      if (msg.approve && p) {
        room.applyBuyIn(p, req.amount);
        room.log(`${p.name} adds ${fmt(req.amount)}${req.note ? ` (${req.note})` : ''}.`);
      } else {
        room.log(`The host declined ${req.name}'s request for ${fmt(req.amount)}.`);
      }
      room.pending = room.pending.filter((r) => r !== req);
      break;
    }

    /* ---- host tools ---- */
    case 'host.adjust': {
      needHost('change stacks');
      const p = target(msg.pid);
      const delta = num(msg.delta, { min: -1e7, max: 1e7, int: room.mode === 'poker', name: 'Amount' });
      if (!delta) throw userError('Enter an amount.');
      if (room.liveInHand(p.id)) throw userError('Change stacks between hands.');
      if (p.stack + delta < Math.min(0, p.stack)) throw userError(`${p.name} only has ${fmt(p.stack)}.`);
      p.stack = r2(p.stack + delta);
      if (msg.ledger) {
        p.buyIn = r2(p.buyIn + delta);
        room.log(delta > 0 ? `${p.name} adds ${fmt(delta)} (host).` : `${p.name} cashes out ${fmt(-delta)}.`);
      } else {
        room.log(`Host corrected ${p.name}'s stack by ${delta > 0 ? '+' : '−'}${fmt(Math.abs(delta))}.`);
      }
      break;
    }
    case 'host.settings': {
      needHost('change table settings');
      if (room.hand || (room.bj && room.bj.phase === 'playing')) throw userError('Change settings between hands.');
      const before = room.settings;
      room.settings = cleanSettings(room.mode, msg.settings || {}, room.settings);
      if (room.mode === 'poker' && (before.smallBlind !== room.settings.smallBlind || before.bigBlind !== room.settings.bigBlind)) {
        room.log(`Blinds are now ${fmt(room.settings.smallBlind)}/${fmt(room.settings.bigBlind)}.`);
      } else room.log('The host changed the table settings.');
      break;
    }
    case 'host.move': {
      needHost('change seats');
      if (room.hand) throw userError('Change seats between hands.');
      const i = room.players.findIndex((p) => p.id === msg.pid);
      const j = i + (msg.dir < 0 ? -1 : 1);
      if (i < 0 || j < 0 || j >= room.players.length) break;
      [room.players[i], room.players[j]] = [room.players[j], room.players[i]];
      break;
    }
    case 'host.kick': {
      needHost('remove players');
      const p = target(msg.pid);
      if (p.id === me.id) throw userError('Use "Leave table" to leave.');
      room.removePlayer(p.id, 'was removed');
      break;
    }
    case 'host.transfer': {
      needHost('hand over the table');
      const p = target(msg.pid);
      room.hostId = p.id;
      room.hostOfflineSince = p.connected ? null : Date.now();
      room.log(`${p.name} is the host now.`);
      break;
    }
    case 'host.claim': {
      if (isHost) break;
      if (!room.hostOfflineSince || Date.now() - room.hostOfflineSince < HOST_CLAIM_AFTER_MS) throw userError('The host is still connected.');
      room.hostId = me.id;
      room.hostOfflineSince = null;
      room.log(`${me.name} took over as host.`);
      break;
    }
    case 'host.undo': {
      needHost('undo');
      const snap = room.undo.pop();
      if (!snap) throw userError('Nothing to undo.');
      room.restoreSnapshot(snap, { keepLogs: true });
      room.log('The host undid the last action.');
      break;
    }

    /* ---- me ---- */
    case 'me.sitout':
      me.sittingOut = !!msg.value;
      room.log(me.sittingOut ? `${me.name} sits out.` : `${me.name} is back in.`);
      break;
    case 'me.rename': {
      const name = cleanName(msg.name);
      if (room.players.some((p) => p.id !== me.id && p.name.toLowerCase() === name.toLowerCase())) throw userError('Someone at this table already has that name.');
      room.log(`${me.name} is now ${name}.`);
      me.name = name;
      break;
    }
    case 'me.leave': room.removePlayer(me.id, 'left'); break;
    default: throw userError('Unknown action.');
  }
}

/** Run one action atomically: on any error the room is rolled back. */
function dispatch(room, me, msg) {
  if (!msg || typeof msg.type !== 'string') throw userError('Unknown action.');
  const before = room.snapshot();
  const hostBefore = room.hostId;
  const settingsBefore = room.settings;
  try {
    handle(room, me, msg);
  } catch (e) {
    room.restoreSnapshot(before);
    room.hostId = hostBefore;
    room.settings = settingsBefore;
    room.effects = [];
    throw e;
  }
  if (UNDOABLE.has(msg.type)) {
    room.undo.push(before);
    if (room.undo.length > UNDO_DEPTH) room.undo.shift();
  }
  room.lastActive = Date.now();
}

/* -------------------------------------------------------------------- store */

class RoomStore {
  constructor() { this.rooms = new Map(); }

  get(code) { return this.rooms.get(String(code || '').trim()); }

  newCode() {
    for (let i = 0; i < 5000; i++) {
      const code = String(1000 + Math.floor(Math.random() * 9000));
      if (!this.rooms.has(code)) return code;
    }
    throw userError('All tables are taken right now. Try again in a minute.');
  }

  create(name, mode, settings) {
    if (!['poker', 'blackjack'].includes(mode)) throw userError('Pick Poker or Blackjack.');
    const room = new Room(this.newCode(), mode);
    room.settings = cleanSettings(mode, settings || {}, room.settings);
    const host = room.addPlayer(name);
    room.hostId = host.id;
    if (mode === 'blackjack') blackjack.init(room);
    this.rooms.set(room.code, room);
    return { room, player: host };
  }

  /** Rebuild a table from the backup the host's phone kept (after a server restart). */
  restore(b, playerId, token) {
    if (!b || typeof b !== 'object' || !/^\d{4}$/.test(String(b.code)) || !Array.isArray(b.players)) throw userError('That backup cannot be read.');
    if (!['poker', 'blackjack'].includes(b.mode) || b.players.length > MAX_PLAYERS + 4) throw userError('That backup cannot be read.');
    const host = b.players.find((p) => p && p.id === playerId && p.token === token);
    if (!host || b.hostId !== playerId) throw userError('Only the host can bring a table back.');
    if (this.rooms.has(String(b.code))) throw userError('That table is already running.');
    const room = new Room(String(b.code), b.mode);
    room.settings = cleanSettings(b.mode, b.settings || {}, room.settings);
    room.hostId = b.hostId;
    room.createdAt = Number(b.createdAt) || Date.now();
    room.players = b.players.map((p) => ({
      id: String(p.id), token: String(p.token), name: cleanName(p.name), stack: Number(p.stack) || 0, buyIn: Number(p.buyIn) || 0,
      connected: false, socketId: null, sittingOut: !!p.sittingOut, left: !!p.left,
    }));
    room.dealerId = b.dealerId || null;
    room.nextDealerId = b.nextDealerId || null;
    room.handNo = Number(b.handNo) || 0;
    room.hand = b.hand || null;
    room.lastResult = b.lastResult || null;
    room.pending = Array.isArray(b.pending) ? b.pending : [];
    room.cashedOut = Array.isArray(b.cashedOut) ? b.cashedOut : [];
    room.logs = Array.isArray(b.logs) ? b.logs.slice(-30) : [];
    room.logSeq = Number(b.logSeq) || room.logs.length;
    if (b.mode === 'blackjack') {
      blackjack.init(room);
      if (b.bj && typeof b.bj === 'object') room.bj = { ...room.bj, ...b.bj };
    }
    room.log('Table restored after a server restart.');
    this.rooms.set(room.code, room);
    return room;
  }

  sweep(now = Date.now()) {
    for (const [code, room] of this.rooms) {
      const idle = now - room.lastActive;
      const anyone = room.players.some((p) => p.connected);
      if (idle > 24 * 3600e3 || (!anyone && idle > 3 * 3600e3) || !room.players.some((p) => !p.left)) this.rooms.delete(code);
    }
  }
}

module.exports = { Room, RoomStore, dispatch, cleanSettings, DEFAULTS, MAX_PLAYERS };
