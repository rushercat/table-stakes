'use strict';
/** End-to-end over real sockets: several "phones" at one table. */
const test = require('node:test');
const assert = require('node:assert/strict');
const { io: connect } = require('socket.io-client');
const { server, io, store } = require('../server');

let url;
const phones = [];

function phone() {
  const s = connect(url, { transports: ['websocket'], forceNew: true });
  s.state = null;
  s.on('state', (st) => { s.state = st; });
  s.on('backup', (b) => { s.backup = b; });
  phones.push(s);
  return s;
}
const ask = (s, ev, msg) => new Promise((res) => s.emit(ev, msg, res));
const act = (s, type, payload) => ask(s, 'action', { type, ...payload });
const tick = (ms = 40) => new Promise((r) => setTimeout(r, ms));
async function until(fn, label) {
  for (let i = 0; i < 100; i++) { if (fn()) return; await tick(20); }
  throw new Error('timed out waiting for: ' + label);
}

test.before(async () => {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  url = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => {
  phones.forEach((p) => p.close());
  io.close();
  server.close();
});

test('host a table, join by code, play, and stay in sync', async () => {
  const a = phone(), b = phone(), c = phone();
  const made = await ask(a, 'room:create', { name: 'Ann', mode: 'poker', settings: { startingStack: 500, smallBlind: 5, bigBlind: 10 } });
  assert.equal(made.ok, true);
  assert.match(made.code, /^\d{4}$/);

  const bad = await ask(b, 'room:join', { code: made.code === '1234' ? '4321' : '1234', name: 'Ben' });
  assert.equal(bad.ok, false);
  const jb = await ask(b, 'room:join', { code: made.code, name: 'Ben' });
  const jc = await ask(c, 'room:join', { code: made.code, name: 'Ann' }); // duplicate name gets a suffix
  assert.equal(jb.ok && jc.ok, true);
  await until(() => a.state && a.state.players.length === 3, 'three players');
  assert.deepEqual(a.state.players.map((p) => p.name), ['Ann', 'Ben', 'Ann 2']);
  assert.equal(a.state.players.some((p) => 'token' in p), false, 'seat tokens are never broadcast');

  assert.equal((await act(b, 'poker.start')).ok, false, 'only the host deals');
  assert.equal((await act(a, 'poker.start')).ok, true);
  await until(() => c.state.hand && c.state.hand.toActId === made.playerId, 'hand started');
  assert.equal((await act(b, 'poker.act', { action: 'call' })).ok, false, 'out of turn');
  assert.equal((await act(a, 'poker.act', { action: 'raise', amount: 30 })).ok, true);
  await until(() => b.state.hand.currentBet === 30 && b.state.hand.toActId === jb.playerId, 'raise seen by everyone');
  assert.equal(b.state.hand.potTotal, 45);

  // Garbage input is rejected without breaking the table.
  for (const junk of [null, {}, { type: 'poker.act', action: 'raise', amount: 'lots' }, { type: 'poker.act', action: 'raise', amount: -5 }, { type: 'host.adjust', pid: jb.playerId, delta: 1e12 }]) {
    const r = await ask(b, 'action', junk);
    assert.equal(r.ok, false);
  }
  assert.equal((await act(b, 'poker.act', { action: 'fold' })).ok, true);
  assert.equal((await act(c, 'poker.act', { action: 'fold' })).ok, true);
  await until(() => a.state.hand === null, 'hand over');
  assert.equal(a.state.players[0].stack, 515);

  /* --- phone locks: seat is kept, reconnect with the stored token restores it --- */
  b.close();
  await until(() => a.state.players[1].connected === false, 'Ben shown offline');
  const b2 = phone();
  assert.equal((await ask(b2, 'room:rejoin', { code: made.code, playerId: jb.playerId, token: 'wrong' })).ok, false);
  const back = await ask(b2, 'room:rejoin', { code: made.code, playerId: jb.playerId, token: jb.token });
  assert.equal(back.ok, true);
  await until(() => b2.state && a.state.players[1].connected === true, 'Ben back');
  assert.equal(b2.state.players[1].stack, 495);

  /* --- server restart: the host's backup rebuilds the table, everyone rejoins --- */
  await until(() => a.backup && a.backup.players[1].stack === 495, 'host has a fresh backup');
  const backup = JSON.parse(JSON.stringify(a.backup));
  store.rooms.clear();
  assert.equal((await ask(b2, 'room:rejoin', { code: made.code, playerId: jb.playerId, token: jb.token })).reason, 'no_room');
  assert.equal((await ask(b2, 'room:restore', { backup, playerId: jb.playerId, token: jb.token })).ok, false, 'only the host can restore');
  assert.equal((await ask(a, 'room:restore', { backup, playerId: made.playerId, token: made.token })).ok, true);
  assert.equal((await ask(b2, 'room:rejoin', { code: made.code, playerId: jb.playerId, token: jb.token })).ok, true);
  await until(() => b2.state.players.length === 3 && b2.state.players[0].stack === 515 && b2.state.handNo === 1, 'restored state');

  /* --- removing a player tells their phone --- */
  let removed = null;
  b2.on('removed', (m) => { removed = m; });
  assert.equal((await act(a, 'host.kick', { pid: jb.playerId })).ok, true);
  await until(() => removed && removed.kicked === true, 'kick notice');
  await until(() => a.state.players.length === 2, 'seat freed');
});

test('blackjack round over sockets', async () => {
  const d = phone(), p = phone();
  const made = await ask(d, 'room:create', { name: 'Dee', mode: 'blackjack', settings: { startingStack: 200, minBet: 10, maxBet: 100 } });
  const jp = await ask(p, 'room:join', { code: made.code, name: 'Pat' });
  assert.equal((await act(p, 'bj.bet', { amount: 40 })).ok, true);
  assert.equal((await act(p, 'bj.deal')).ok, false);
  assert.equal((await act(d, 'bj.deal')).ok, true);
  await until(() => p.state.bj.phase === 'playing', 'dealt');
  const hand = p.state.bj.hands[0];
  assert.equal((await act(p, 'bj.resolve', { handId: hand.id, result: 'win' })).ok, false, 'players cannot pay themselves');
  assert.equal((await act(d, 'bj.resolve', { handId: hand.id, result: 'blackjack' })).ok, true);
  await until(() => p.state.players.find((x) => x.id === jp.playerId).stack === 260, 'paid 3:2');
  assert.equal(p.state.bj.house, -60);
  assert.equal((await act(d, 'bj.newRound')).ok, true);
});
