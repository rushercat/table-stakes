'use strict';
/**
 * Blackjack chip engine — bets and payouts only, no cards.
 * Players bet, the dealer closes betting, deals real cards, then settles each hand
 * with one tap: win (1:1), blackjack (3:2 or 6:5), push, or lose.
 */
const { userError, r2, uid, fmt } = require('./util');

const player = (room, id) => room.players.find((p) => p.id === id);
const nameOf = (room, id) => (player(room, id) || {}).name || 'Player';

function init(room) {
  room.bj = { phase: 'betting', round: 1, dealerId: room.hostId, house: 0, hands: [], lastBets: {} };
}

/** Chips returned to the player for a result (stake already left their stack). */
function returnFor(room, hand, result) {
  switch (result) {
    case 'win': return r2(hand.bet * 2);
    case 'blackjack': return r2(hand.bet + hand.bet * room.settings.bjPayout);
    case 'push': return hand.bet;
    case 'lose': return 0;
    default: return 0;
  }
}

/** The bank is either an abstract house tally or the dealer's own stack. */
function bank(room, delta) {
  if (!delta) return;
  if (room.settings.bankMode === 'dealer') {
    const d = player(room, room.bj.dealerId);
    if (d) { d.stack = r2(d.stack + delta); return; }
  }
  room.bj.house = r2(room.bj.house + delta);
}

function bet(room, pid, amount) {
  const bj = room.bj;
  if (bj.phase !== 'betting') throw userError('Bets are closed for this round.');
  if (pid === bj.dealerId) throw userError('The dealer does not bet.');
  const p = player(room, pid);
  if (!p || p.left) throw userError('Player not found.');
  const existing = bj.hands.find((h) => h.pid === pid);
  const available = r2(p.stack + (existing ? existing.bet : 0));
  if (amount > 0) {
    const { minBet, maxBet } = room.settings;
    if (amount < minBet) throw userError(`The minimum bet is ${fmt(minBet)}.`);
    if (amount > maxBet) throw userError(`The maximum bet is ${fmt(maxBet)}.`);
    if (amount > available) throw userError('You do not have that many chips.');
  }
  if (existing) {
    p.stack = r2(p.stack + existing.bet);
    bj.hands = bj.hands.filter((h) => h !== existing);
  }
  if (amount > 0) {
    p.stack = r2(p.stack - amount);
    bj.hands.push({ id: uid(4), pid, bet: amount, base: amount, doubled: false, split: false, result: null });
    room.log(`${p.name} bets ${fmt(amount)}.`);
  } else if (existing) {
    room.log(`${p.name} takes back their bet.`);
  }
}

function deal(room) {
  const bj = room.bj;
  if (bj.phase !== 'betting') throw userError('This round is already being played.');
  if (!bj.hands.length) throw userError('Nobody has placed a bet yet.');
  bj.phase = 'playing';
  bj.lastBets = {};
  for (const h of bj.hands) bj.lastBets[h.pid] = h.base;
  room.log(`Bets closed — ${bj.hands.length} ${bj.hands.length === 1 ? 'hand' : 'hands'} in play. Deal the cards.`);
}

function findOpenHand(room, handId) {
  const bj = room.bj;
  if (bj.phase !== 'playing') throw userError('That only works while a round is being played.');
  const h = bj.hands.find((x) => x.id === handId);
  if (!h) throw userError('Hand not found.');
  if (h.result) throw userError('That hand is already settled.');
  return h;
}

function double(room, handId) {
  const h = findOpenHand(room, handId);
  if (h.doubled) throw userError('That hand is already doubled.');
  const p = player(room, h.pid);
  if (!p || p.stack < h.base) throw userError('Not enough chips to double down.');
  p.stack = r2(p.stack - h.base);
  h.bet = r2(h.bet + h.base);
  h.doubled = true;
  room.log(`${p.name} doubles down to ${fmt(h.bet)}.`);
}

function split(room, handId) {
  const h = findOpenHand(room, handId);
  if (h.doubled) throw userError('A doubled hand cannot be split.');
  const p = player(room, h.pid);
  if (!p || p.stack < h.base) throw userError('Not enough chips to split.');
  if (room.bj.hands.filter((x) => x.pid === h.pid).length >= 4) throw userError('A player can have at most 4 hands.');
  p.stack = r2(p.stack - h.base);
  h.split = true;
  const idx = room.bj.hands.indexOf(h);
  room.bj.hands.splice(idx + 1, 0, { id: uid(4), pid: h.pid, bet: h.base, base: h.base, doubled: false, split: true, result: null });
  room.log(`${p.name} splits — two hands of ${fmt(h.base)}.`);
}

/** Settle one hand. Tapping a different result on a settled hand corrects it. */
function resolve(room, handId, result, quiet) {
  const bj = room.bj;
  if (bj.phase !== 'playing') throw userError('Close the bets before settling hands.');
  if (!['win', 'blackjack', 'push', 'lose', null].includes(result)) throw userError('Unknown result.');
  const h = bj.hands.find((x) => x.id === handId);
  if (!h) throw userError('Hand not found.');
  const p = player(room, h.pid);
  if (h.result) {
    const back = returnFor(room, h, h.result);
    if (p) p.stack = r2(p.stack - back);
    bank(room, r2(back - h.bet));
    h.result = null;
  }
  if (!result) return;
  const ret = returnFor(room, h, result);
  if (p) p.stack = r2(p.stack + ret);
  bank(room, r2(h.bet - ret));
  h.result = result;
  h.net = r2(ret - h.bet);
  if (!quiet) {
    const who = nameOf(room, h.pid);
    const text = { win: `wins ${fmt(h.bet)}`, blackjack: `has blackjack — wins ${fmt(h.net)}`, push: 'pushes', lose: `loses ${fmt(h.bet)}` }[result];
    room.log(`${who} ${text}.`);
  }
}

function resolveAll(room, result) {
  const open = room.bj.hands.filter((h) => !h.result);
  if (room.bj.phase !== 'playing') throw userError('Close the bets before settling hands.');
  if (!open.length) throw userError('Every hand is already settled.');
  for (const h of open) resolve(room, h.id, result, true);
  const text = { win: 'win', push: 'push', lose: 'lose', blackjack: 'are paid blackjack' }[result];
  room.log(`All ${open.length} open ${open.length === 1 ? 'hand' : 'hands'} ${text}.`);
}

function newRound(room) {
  const bj = room.bj;
  if (bj.phase !== 'playing') throw userError('A betting round is already open.');
  if (bj.hands.some((h) => !h.result)) throw userError('Settle every hand first.');
  bj.phase = 'betting';
  bj.hands = [];
  bj.round += 1;
  room.purgeLeft();
  room.log(`Round ${bj.round} — place your bets.`);
}

function setDealer(room, pid) {
  const bj = room.bj;
  if (bj.phase !== 'betting') throw userError('Change the dealer between rounds.');
  const p = player(room, pid);
  if (!p || p.left) throw userError('Player not found.');
  const existing = bj.hands.find((h) => h.pid === pid);
  if (existing) { p.stack = r2(p.stack + existing.bet); bj.hands = bj.hands.filter((h) => h !== existing); }
  bj.dealerId = pid;
  room.log(`${p.name} is the dealer now.`);
}

/** A player leaves mid-round: open bets are returned (betting) or forfeited to the bank (playing). */
function removePlayer(room, pid) {
  const bj = room.bj;
  const p = player(room, pid);
  for (const h of bj.hands.filter((x) => x.pid === pid)) {
    if (bj.phase === 'betting') { if (p) p.stack = r2(p.stack + h.bet); }
    else if (!h.result) bank(room, h.bet);
  }
  bj.hands = bj.hands.filter((h) => h.pid !== pid);
  delete bj.lastBets[pid];
}

/** The dealer left: the host takes over the shoe. */
function setDealerOnLeave(room) {
  const bj = room.bj;
  const host = player(room, room.hostId);
  if (!host) return;
  const existing = bj.hands.find((h) => h.pid === host.id && !h.result);
  if (existing && bj.phase === 'betting') { host.stack = r2(host.stack + existing.bet); bj.hands = bj.hands.filter((h) => h !== existing); }
  bj.dealerId = host.id;
  room.log(`${host.name} is the dealer now.`);
}

module.exports = { init, bet, deal, double, split, resolve, resolveAll, newRound, setDealer, setDealerOnLeave, removePlayer };
