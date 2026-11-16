'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { RoomStore, dispatch } = require('../src/rooms');

function table(mode, names, settings) {
  const store = new RoomStore();
  const { room, player } = store.create(names[0], mode, settings);
  const players = [player, ...names.slice(1).map((n) => room.addPlayer(n))];
  const id = Object.fromEntries(players.map((p) => [p.name, p.id]));
  const host = player;
  const as = (name, msg) => dispatch(room, room.player(id[name]), msg);
  const act = (name, action, amount) => as(name, { type: 'poker.act', action, amount });
  const stack = (name) => room.player(id[name]).stack;
  const total = () => room.players.reduce((s, p) => s + p.stack, 0) + (room.hand ? room.hand.order.reduce((s, pid) => s + room.hand.seats[pid].committed, 0) - Object.values(room.hand.results || {}).reduce((a, b) => a + b, 0) : 0);
  return { store, room, id, host, as, act, stack, total };
}

test('heads-up: dealer posts the small blind and acts first preflop, last postflop', () => {
  const t = table('poker', ['Ann', 'Ben'], { startingStack: 1000, smallBlind: 5, bigBlind: 10 });
  t.as('Ann', { type: 'poker.start' });
  const h = t.room.hand;
  assert.equal(h.dealerId, t.id.Ann);
  assert.equal(h.sbId, t.id.Ann);
  assert.equal(h.bbId, t.id.Ben);
  assert.equal(h.toActId, t.id.Ann);
  assert.equal(t.stack('Ann'), 995);
  assert.equal(t.stack('Ben'), 990);
  t.act('Ann', 'call');
  assert.equal(t.room.hand.street, 'preflop', 'big blind still has the option');
  assert.equal(t.room.hand.toActId, t.id.Ben);
  t.act('Ben', 'check');
  assert.equal(t.room.hand.street, 'flop');
  assert.equal(t.room.hand.toActId, t.id.Ben, 'non-dealer acts first after the flop');
  t.act('Ben', 'raise', 20);
  t.act('Ann', 'fold');
  assert.equal(t.room.hand, null);
  assert.equal(t.stack('Ben'), 1010);
  assert.equal(t.stack('Ann'), 990);
  // Button moves.
  t.as('Ann', { type: 'poker.start' });
  assert.equal(t.room.hand.dealerId, t.id.Ben);
});

test('turn order is enforced and only the host deals', () => {
  const t = table('poker', ['Ann', 'Ben', 'Cy']);
  assert.throws(() => t.as('Ben', { type: 'poker.start' }), /Only the host/);
  t.as('Ann', { type: 'poker.start' });
  // 3-handed: Ann button, Ben SB, Cy BB, Ann first to act.
  assert.equal(t.room.hand.toActId, t.id.Ann);
  assert.throws(() => t.act('Ben', 'call'), /turn/);
  assert.throws(() => t.act('Ann', 'check'), /can't check/);
  assert.throws(() => t.act('Ann', 'raise', 15), /minimum is 20/);
  // The host may act for someone whose phone died.
  t.act('Ann', 'call');
  t.as('Ann', { type: 'poker.act', action: 'call', forId: t.id.Ben });
  assert.equal(t.room.hand.toActId, t.id.Cy);
});

test('side pots: short all-in creates a main pot and a side pot', () => {
  const t = table('poker', ['Ann', 'Ben', 'Cy'], { startingStack: 300, smallBlind: 5, bigBlind: 10 });
  t.room.player(t.id.Ann).stack = 100;
  t.as('Ann', { type: 'poker.start' });
  t.act('Ann', 'allin'); // 100
  t.act('Ben', 'call');
  t.act('Cy', 'call');
  assert.equal(t.room.hand.street, 'flop');
  t.act('Ben', 'raise', 50);
  t.act('Cy', 'call');
  t.act('Ben', 'check'); // turn
  t.act('Cy', 'check');
  t.act('Ben', 'check'); // river
  t.act('Cy', 'check');
  const h = t.room.hand;
  assert.equal(h.street, 'showdown');
  assert.deepEqual(h.pots.map((p) => p.amount), [300, 100]);
  assert.equal(h.pots[0].eligible.length, 3);
  assert.deepEqual(h.pots[1].eligible.sort(), [t.id.Ben, t.id.Cy].sort());
  // Ann cannot win the side pot she is not in for.
  assert.throws(() => t.as('Ann', { type: 'poker.award', pot: 1, winners: [t.id.Ann] }), /in for that pot/);
  t.as('Ann', { type: 'poker.award', pot: 0, winners: [t.id.Ann] }); // winner claims main pot
  t.as('Cy', { type: 'poker.award', pot: 1, winners: [t.id.Cy] });
  assert.equal(t.room.hand, null);
  assert.equal(t.stack('Ann'), 300);
  assert.equal(t.stack('Ben'), 150);
  assert.equal(t.stack('Cy'), 250);
});

test('an all-in that is not a full raise does not reopen the betting', () => {
  const t = table('poker', ['Ann', 'Ben', 'Cy'], { startingStack: 1000, smallBlind: 5, bigBlind: 10 });
  t.room.player(t.id.Cy).stack = 40;
  t.as('Ann', { type: 'poker.start' }); // Ann btn, Ben SB, Cy BB (posts 10, 30 behind)
  t.act('Ann', 'raise', 30);
  t.act('Ben', 'call');
  t.act('Cy', 'allin'); // to 40: a raise of 10, less than the 20 needed
  assert.equal(t.room.hand.currentBet, 40);
  assert.equal(t.room.hand.toActId, t.id.Ann);
  assert.throws(() => t.act('Ann', 'raise', 100), /only call or fold/);
  t.act('Ann', 'call');
  t.act('Ben', 'call');
  assert.equal(t.room.hand.street, 'flop');
});

test('uncalled part of a bet is returned automatically', () => {
  const t = table('poker', ['Ann', 'Ben'], { startingStack: 500, smallBlind: 5, bigBlind: 10 });
  t.room.player(t.id.Ben).stack = 70;
  t.as('Ann', { type: 'poker.start' });
  t.act('Ann', 'raise', 200);
  t.act('Ben', 'allin'); // calls for 70 total
  const h = t.room.hand;
  assert.equal(h.street, 'showdown');
  assert.equal(h.runout, true);
  assert.equal(t.stack('Ann'), 430, '130 uncalled chips came straight back');
  const open = h.pots.filter((p) => !p.awarded);
  assert.equal(open.length, 1);
  assert.equal(open[0].amount, 140);
  t.as('Ann', { type: 'poker.award', pot: h.pots.indexOf(open[0]), winners: [t.id.Ben] });
  assert.equal(t.stack('Ben'), 140);
});

test('split pot gives the odd chip to the first winner left of the button', () => {
  const t = table('poker', ['Ann', 'Ben', 'Cy'], { startingStack: 100, smallBlind: 5, bigBlind: 10 });
  t.as('Ann', { type: 'poker.start' });
  t.act('Ann', 'call'); t.act('Ben', 'fold'); t.act('Cy', 'check'); // pot 25
  for (let i = 0; i < 3; i++) { t.act('Cy', 'check'); t.act('Ann', 'check'); }
  assert.equal(t.room.hand.street, 'showdown');
  assert.throws(() => t.as('Cy', { type: 'poker.award', pot: 0, winners: [t.id.Ann, t.id.Cy] }), /Only the host/);
  t.as('Ann', { type: 'poker.award', pot: 0, winners: [t.id.Ann, t.id.Cy] });
  assert.equal(t.stack('Cy'), 90 + 13);
  assert.equal(t.stack('Ann'), 90 + 12);
});

test('misdeal returns every chip and keeps the button', () => {
  const t = table('poker', ['Ann', 'Ben', 'Cy']);
  t.as('Ann', { type: 'poker.start' });
  t.act('Ann', 'raise', 50);
  t.as('Ann', { type: 'poker.abort' });
  assert.deepEqual([t.stack('Ann'), t.stack('Ben'), t.stack('Cy')], [1000, 1000, 1000]);
  t.as('Ann', { type: 'poker.start' });
  assert.equal(t.room.hand.dealerId, t.id.Ann);
  assert.equal(t.room.hand.no, 1);
});

test('undo rolls back the last action', () => {
  const t = table('poker', ['Ann', 'Ben']);
  t.as('Ann', { type: 'poker.start' });
  t.act('Ann', 'raise', 100);
  assert.equal(t.stack('Ann'), 900);
  t.as('Ann', { type: 'host.undo' });
  assert.equal(t.stack('Ann'), 995);
  assert.equal(t.room.hand.toActId, t.id.Ann);
});

test('a player leaving mid-hand is folded and the hand carries on', () => {
  const t = table('poker', ['Ann', 'Ben', 'Cy']);
  t.as('Ann', { type: 'poker.start' });
  t.as('Ann', { type: 'me.leave' }); // Ann was first to act and is the host
  assert.equal(t.room.hostId, t.id.Ben);
  assert.equal(t.room.hand.toActId, t.id.Ben);
  t.act('Ben', 'fold');
  assert.equal(t.room.hand, null);
  assert.equal(t.room.players.length, 2, 'Ann is gone once the hand is over');
  assert.equal(t.room.cashedOut[0].name, 'Ann');
});

test('buy-ins need host approval and are blocked while live in a hand', () => {
  const t = table('poker', ['Ann', 'Ben']);
  t.as('Ben', { type: 'buyin.request', amount: 500, note: 'scan: 5×100' });
  assert.equal(t.stack('Ben'), 1000);
  assert.equal(t.room.pending.length, 1);
  t.as('Ann', { type: 'poker.start' });
  assert.throws(() => t.as('Ann', { type: 'buyin.decide', id: t.room.pending[0].id, approve: true }), /between hands/);
  t.act('Ann', 'fold');
  t.as('Ann', { type: 'buyin.decide', id: t.room.pending[0].id, approve: true });
  assert.equal(t.stack('Ben'), 1000 - 10 + 15 + 500);
  assert.equal(t.room.player(t.id.Ben).buyIn, 1500);
  assert.throws(() => t.as('Ben', { type: 'buyin.request', amount: -5 }), /at least 1/);
  assert.throws(() => t.as('Ben', { type: 'buyin.request', amount: 'abc' }), /number/);
});

test('fuzz: random play never loses or creates chips and every hand ends', () => {
  let seed = 12345;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  for (let game = 0; game < 40; game++) {
    const n = 2 + Math.floor(rnd() * 5);
    const names = ['A', 'B', 'C', 'D', 'E', 'F'].slice(0, n);
    const t = table('poker', names, { startingStack: 200 + Math.floor(rnd() * 800), smallBlind: 5, bigBlind: 10 });
    const bank = t.room.players.reduce((s, p) => s + p.stack, 0);
    for (let hand = 0; hand < 25; hand++) {
      if (t.room.players.filter((p) => p.stack > 0).length < 2) break;
      t.as('A', { type: 'poker.start' });
      let steps = 0;
      while (t.room.hand && steps++ < 400) {
        const h = t.room.hand;
        if (h.street === 'showdown') {
          const i = h.pots.findIndex((p) => !p.awarded);
          const elig = h.pots[i].eligible;
          const k = 1 + Math.floor(rnd() * Math.min(2, elig.length));
          t.as('A', { type: 'poker.award', pot: i, winners: elig.slice(0, k) });
          continue;
        }
        const pid = h.toActId;
        const p = t.room.player(pid);
        const seat = h.seats[pid];
        const toCall = Math.max(0, h.currentBet - seat.bet);
        const r = rnd();
        let action; let amount;
        if (r < 0.12) action = 'fold';
        else if (r < 0.55) action = toCall > 0 ? 'call' : 'check';
        else if (r < 0.68) action = 'allin';
        else {
          const minTo = h.currentBet + h.lastRaise;
          const maxTo = seat.bet + p.stack;
          if (seat.raiseLocked || maxTo <= h.currentBet) action = toCall > 0 ? 'call' : 'check';
          else { action = 'raise'; amount = minTo >= maxTo ? maxTo : minTo + Math.floor(rnd() * (maxTo - minTo + 1)); }
        }
        dispatch(t.room, t.room.player(t.room.hostId), { type: 'poker.act', action, amount, forId: pid });
        const live = t.room.players.reduce((s, x) => s + x.stack, 0) + (t.room.hand ? t.room.hand.order.reduce((s, x) => s + t.room.hand.seats[x].committed, 0) - Object.values(t.room.hand.results || {}).reduce((a, b) => a + b, 0) : 0);
        assert.equal(live, bank, 'chips are conserved after every action');
        assert.ok(t.room.players.every((x) => x.stack >= 0), 'no negative stacks');
      }
      assert.equal(t.room.hand, null, 'hand finished');
      assert.equal(t.room.players.reduce((s, p) => s + p.stack, 0), bank);
    }
  }
});

test('blackjack: bets, double, split and the four results', () => {
  const t = table('blackjack', ['Dee', 'Ann', 'Ben', 'Cy'], { startingStack: 1000, minBet: 10, maxBet: 500 });
  assert.equal(t.room.bj.dealerId, t.id.Dee);
  assert.throws(() => t.as('Dee', { type: 'bj.bet', amount: 50 }), /dealer does not bet/);
  assert.throws(() => t.as('Ann', { type: 'bj.bet', amount: 5 }), /minimum bet/);
  assert.throws(() => t.as('Ann', { type: 'bj.bet', amount: 600 }), /maximum bet/);
  t.as('Ann', { type: 'bj.bet', amount: 100 });
  t.as('Ann', { type: 'bj.bet', amount: 50 }); // change of mind
  assert.equal(t.stack('Ann'), 950);
  t.as('Ben', { type: 'bj.bet', amount: 20 });
  t.as('Cy', { type: 'bj.bet', amount: 30 });
  assert.throws(() => t.as('Ann', { type: 'bj.deal' }), /Only the dealer/);
  t.as('Dee', { type: 'bj.deal' });
  assert.throws(() => t.as('Ann', { type: 'bj.bet', amount: 10 }), /closed/);

  const hand = (name) => t.room.bj.hands.filter((h) => h.pid === t.id[name]);
  t.as('Ben', { type: 'bj.double', handId: hand('Ben')[0].id });
  assert.equal(t.stack('Ben'), 960);
  t.as('Cy', { type: 'bj.split', handId: hand('Cy')[0].id });
  assert.equal(hand('Cy').length, 2);
  assert.equal(t.stack('Cy'), 940);

  t.as('Dee', { type: 'bj.resolve', handId: hand('Ann')[0].id, result: 'blackjack' });
  assert.equal(t.stack('Ann'), 950 + 50 + 75);
  t.as('Dee', { type: 'bj.resolve', handId: hand('Ben')[0].id, result: 'win' });
  assert.equal(t.stack('Ben'), 960 + 80);
  t.as('Dee', { type: 'bj.resolve', handId: hand('Cy')[0].id, result: 'push' });
  t.as('Dee', { type: 'bj.resolve', handId: hand('Cy')[1].id, result: 'lose' });
  assert.equal(t.stack('Cy'), 970);
  assert.equal(t.room.bj.house, -75 - 40 + 30);

  // Mis-tap: change Ben's win to a loss.
  t.as('Dee', { type: 'bj.resolve', handId: hand('Ben')[0].id, result: 'lose' });
  assert.equal(t.stack('Ben'), 960);
  assert.equal(t.room.bj.house, -75 + 40 + 30);

  t.as('Dee', { type: 'bj.newRound' });
  assert.equal(t.room.bj.phase, 'betting');
  assert.equal(t.room.bj.lastBets[t.id.Ann], 50);
  // Chips + house always add up.
  assert.equal(t.room.players.reduce((s, p) => s + p.stack, 0) + t.room.bj.house, 4000);
});

test('blackjack: settle-all and dealer-banked tables', () => {
  const t = table('blackjack', ['Dee', 'Ann', 'Ben'], { startingStack: 500, minBet: 5, maxBet: 100, bankMode: 'dealer', bjPayout: 1.2 });
  t.as('Ann', { type: 'bj.bet', amount: 25 });
  t.as('Ben', { type: 'bj.bet', amount: 100 });
  t.as('Dee', { type: 'bj.deal' });
  assert.throws(() => t.as('Dee', { type: 'bj.newRound' }), /Settle every hand/);
  const annHand = t.room.bj.hands.find((h) => h.pid === t.id.Ann);
  t.as('Dee', { type: 'bj.resolve', handId: annHand.id, result: 'blackjack' }); // 6:5 → +30
  t.as('Dee', { type: 'bj.resolveAll', result: 'lose' });
  assert.equal(t.stack('Ann'), 530);
  assert.equal(t.stack('Ben'), 400);
  assert.equal(t.stack('Dee'), 500 - 30 + 100);
  assert.equal(t.room.bj.house, 0);
});
