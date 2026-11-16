'use strict';
/**
 * No-limit hold'em betting engine — chips only, no cards.
 * The physical dealer deals; this module tracks the button, blinds, whose turn it is,
 * bet sizes, side pots and payouts.
 */
const { userError, r2, fmt } = require('./util');

const STREETS = ['preflop', 'flop', 'turn', 'river'];

const player = (room, id) => room.players.find((p) => p.id === id);
const nameOf = (room, id) => (player(room, id) || {}).name || 'Player';

function nextInOrder(order, fromId, pred = () => true) {
  const n = order.length;
  const i = order.indexOf(fromId);
  for (let k = 1; k <= n; k++) {
    const id = order[(((i + k) % n) + n) % n];
    if (pred(id)) return id;
  }
  return null;
}

function commit(room, id, amount) {
  const p = player(room, id);
  const seat = room.hand.seats[id];
  const pay = Math.min(amount, p.stack);
  p.stack = r2(p.stack - pay);
  seat.bet = r2(seat.bet + pay);
  seat.committed = r2(seat.committed + pay);
  if (p.stack <= 0) seat.allIn = true;
  return pay;
}

function startHand(room) {
  if (room.hand) throw userError('A hand is already in progress.');
  const elig = room.players.filter((p) => !p.sittingOut && !p.left && p.stack > 0);
  if (elig.length < 2) throw userError('At least 2 players with chips are needed to deal.');
  const order = elig.map((p) => p.id);
  const allIds = room.players.map((p) => p.id);

  let dealerId;
  if (room.nextDealerId && order.includes(room.nextDealerId)) dealerId = room.nextDealerId;
  else if (room.dealerId == null || !allIds.includes(room.dealerId)) dealerId = order[0];
  else dealerId = nextInOrder(allIds, room.dealerId, (id) => order.includes(id));
  room.nextDealerId = null;
  room.dealerId = dealerId;

  const { smallBlind: sb, bigBlind: bb } = room.settings;
  const seats = {};
  for (const id of order) seats[id] = { bet: 0, committed: 0, folded: false, allIn: false, acted: false, raiseLocked: false };
  const headsUp = order.length === 2;
  const sbId = headsUp ? dealerId : nextInOrder(order, dealerId);
  const bbId = nextInOrder(order, sbId);

  room.handNo += 1;
  room.lastResult = null;
  room.hand = {
    no: room.handNo, street: 'preflop', dealerId, sbId, bbId, order, seats,
    currentBet: bb, lastRaise: bb, toActId: null, pots: null, runout: false,
  };
  commit(room, sbId, sb);
  commit(room, bbId, bb);
  room.log(`Hand #${room.handNo}: ${nameOf(room, dealerId)} has the button. Blinds ${fmt(sb)}/${fmt(bb)}.`);
  progress(room, headsUp ? sbId : nextInOrder(order, bbId), true);
}

function needsAction(hand, id) {
  const s = hand.seats[id];
  return !s.folded && !s.allIn && (!s.acted || s.bet < hand.currentBet);
}

/** Move the hand forward: next actor, next street, showdown, or uncontested win. */
function progress(room, fromId, inclusive) {
  const hand = room.hand;
  for (let guard = 0; guard < 6; guard++) {
    const alive = hand.order.filter((id) => !hand.seats[id].folded);
    if (alive.length === 1) return finishUncontested(room, alive[0]);

    const canAct = alive.filter((id) => !hand.seats[id].allIn);
    // A lone player with chips who already covers every all-in has nobody to bet against.
    let lone = false;
    if (canAct.length === 1) {
      const maxOther = Math.max(0, ...alive.filter((id) => id !== canAct[0]).map((id) => hand.seats[id].bet));
      lone = hand.seats[canAct[0]].bet >= maxOther;
    }
    const pending = canAct.length === 0 || lone ? [] : canAct.filter((id) => needsAction(hand, id));
    if (pending.length) {
      const n = hand.order.length;
      const idx = hand.order.indexOf(fromId);
      for (let k = inclusive ? 0 : 1; k <= n; k++) {
        const id = hand.order[(idx + k) % n];
        if (pending.includes(id)) { hand.toActId = id; return; }
      }
    }

    // Betting round is over.
    for (const id of hand.order) hand.seats[id].bet = 0;
    hand.toActId = null;
    if (hand.street === 'river' || canAct.length <= 1) {
      hand.runout = hand.street !== 'river';
      return toShowdown(room);
    }
    hand.street = STREETS[STREETS.indexOf(hand.street) + 1];
    hand.currentBet = 0;
    hand.lastRaise = room.settings.bigBlind;
    for (const id of hand.order) { hand.seats[id].acted = false; hand.seats[id].raiseLocked = false; }
    room.log(`${hand.street[0].toUpperCase()}${hand.street.slice(1)} — pot is ${fmt(potTotal(hand))}.`);
    fromId = hand.dealerId;
    inclusive = false;
  }
}

function potTotal(hand) {
  return r2(hand.order.reduce((s, id) => s + hand.seats[id].committed, 0));
}

/** Main pot + side pots from what each player has committed this hand. */
function calcPots(hand) {
  const entries = hand.order.map((id) => ({ id, c: hand.seats[id].committed, folded: hand.seats[id].folded }));
  const levels = [...new Set(entries.filter((e) => !e.folded && e.c > 0).map((e) => e.c))].sort((a, b) => a - b);
  const pots = [];
  let prev = 0;
  for (const lvl of levels) {
    let amount = 0;
    for (const e of entries) amount += Math.max(0, Math.min(e.c, lvl) - prev);
    const eligible = entries.filter((e) => !e.folded && e.c >= lvl).map((e) => e.id);
    if (amount > 0) {
      const last = pots[pots.length - 1];
      if (last && last.eligible.length === eligible.length && last.eligible.every((id) => eligible.includes(id))) last.amount = r2(last.amount + amount);
      else pots.push({ amount: r2(amount), eligible });
    }
    prev = lvl;
  }
  // Chips a folded player put in above the highest live stack stay in the last pot.
  let extra = 0;
  for (const e of entries) extra += Math.max(0, e.c - prev);
  if (extra > 0) {
    if (pots.length) pots[pots.length - 1].amount = r2(pots[pots.length - 1].amount + extra);
    else pots.push({ amount: r2(extra), eligible: entries.filter((e) => !e.folded).map((e) => e.id) });
  }
  return pots;
}

function toShowdown(room) {
  const hand = room.hand;
  hand.street = 'showdown';
  hand.toActId = null;
  hand.pots = calcPots(hand).map((p) => ({ ...p, awarded: false, winners: null }));
  hand.results = {};
  // A pot only one player can win (e.g. an uncalled bet) goes straight back to them.
  for (const pot of hand.pots) if (pot.eligible.length === 1) payPot(room, pot, [pot.eligible[0]], true);
  if (hand.pots.every((p) => p.awarded)) finishHand(room);
  else room.log(hand.runout ? 'All-in — deal the rest of the board, then award the pot.' : 'Showdown — award the pot.');
}

function payPot(room, pot, winnerIds, quiet) {
  const hand = room.hand;
  // Odd chips go to the first winner(s) left of the button.
  const ordered = [];
  let id = hand.dealerId;
  for (let k = 0; k < hand.order.length; k++) {
    id = nextInOrder(hand.order, id);
    if (winnerIds.includes(id)) ordered.push(id);
  }
  const n = ordered.length;
  const base = Math.floor(pot.amount / n);
  let rem = r2(pot.amount - base * n);
  for (const wid of ordered) {
    let share = base;
    if (rem > 0) { const extra = Math.min(1, rem); share = r2(share + extra); rem = r2(rem - extra); }
    const p = player(room, wid);
    if (p) p.stack = r2(p.stack + share);
    hand.results[wid] = r2((hand.results[wid] || 0) + share);
  }
  pot.awarded = true;
  pot.winners = ordered;
  if (!quiet) {
    const names = ordered.map((w) => nameOf(room, w));
    room.log(n === 1 ? `${names[0]} wins ${fmt(pot.amount)}.` : `${names.join(' & ')} split ${fmt(pot.amount)}.`);
  }
}

function finishUncontested(room, winnerId) {
  const hand = room.hand;
  const total = potTotal(hand);
  const p = player(room, winnerId);
  if (p) p.stack = r2(p.stack + total);
  hand.results = { [winnerId]: total };
  room.log(`${nameOf(room, winnerId)} wins ${fmt(total)} — everyone else folded.`);
  finishHand(room);
}

function finishHand(room) {
  const hand = room.hand;
  room.lastResult = {
    handNo: hand.no,
    winners: Object.entries(hand.results || {}).map(([id, amount]) => ({ id, name: nameOf(room, id), amount, net: r2(amount - hand.seats[id].committed) })),
  };
  room.hand = null;
  room.purgeLeft();
}

function act(room, pid, type, amount) {
  const hand = room.hand;
  if (!hand || hand.street === 'showdown') throw userError('There is no betting right now.');
  if (hand.toActId !== pid) throw userError(`It is ${nameOf(room, hand.toActId)}'s turn.`);
  const seat = hand.seats[pid];
  const p = player(room, pid);
  const toCall = Math.max(0, r2(hand.currentBet - seat.bet));
  const maxTo = r2(seat.bet + p.stack);
  const who = p.name;

  if (type === 'allin') {
    if (maxTo > hand.currentBet && !seat.raiseLocked) { type = 'raise'; amount = maxTo; }
    else type = toCall > 0 ? 'call' : 'check';
  }

  switch (type) {
    case 'fold':
      seat.folded = true;
      room.log(`${who} folds.`);
      break;
    case 'check':
      if (toCall > 0) throw userError(`You can't check — ${fmt(toCall)} to call.`);
      room.log(`${who} checks.`);
      break;
    case 'call': {
      if (toCall <= 0) throw userError('There is nothing to call.');
      const paid = commit(room, pid, toCall);
      room.log(seat.allIn ? `${who} calls ${fmt(paid)} and is all-in.` : `${who} calls ${fmt(paid)}.`);
      break;
    }
    case 'raise': {
      if (!Number.isInteger(amount)) throw userError('Bets must be whole chips.');
      if (seat.raiseLocked) throw userError('You can only call or fold — the last all-in was not a full raise.');
      if (amount <= hand.currentBet) throw userError('A raise has to be higher than the current bet.');
      if (amount > maxTo) throw userError('You do not have that many chips.');
      const minTo = r2(hand.currentBet + hand.lastRaise);
      const shove = amount === maxTo;
      if (amount < minTo && !shove) throw userError(`The minimum is ${fmt(minTo)}.`);
      const opening = hand.currentBet === 0;
      const raiseSize = r2(amount - hand.currentBet);
      const full = raiseSize >= hand.lastRaise;
      commit(room, pid, r2(amount - seat.bet));
      hand.currentBet = amount;
      if (full) hand.lastRaise = raiseSize;
      for (const id of hand.order) {
        if (id === pid) continue;
        const s = hand.seats[id];
        if (s.folded || s.allIn) continue;
        s.acted = false;
        if (full) s.raiseLocked = false;
      }
      room.log(shove ? `${who} is all-in for ${fmt(amount)}.` : `${who} ${opening ? 'bets' : 'raises to'} ${fmt(amount)}.`);
      break;
    }
    default:
      throw userError('Unknown action.');
  }
  seat.acted = true;
  seat.raiseLocked = true;
  progress(room, pid, false);
}

/** Award one pot at showdown to one or more winners (split). */
function award(room, potIndex, winnerIds) {
  const hand = room.hand;
  if (!hand || hand.street !== 'showdown') throw userError('There is no pot to award right now.');
  const pot = hand.pots[potIndex];
  if (!pot || pot.awarded) throw userError('That pot has already been paid out.');
  const winners = [...new Set(winnerIds)];
  if (!winners.length) throw userError('Pick at least one winner.');
  if (!winners.every((id) => pot.eligible.includes(id))) throw userError('Only players who are in for that pot can win it.');
  payPot(room, pot, winners, false);
  if (hand.pots.every((p) => p.awarded)) finishHand(room);
}

/** Misdeal: give everyone their chips back and keep the button where it was. */
function abort(room) {
  const hand = room.hand;
  if (!hand) throw userError('There is no hand to cancel.');
  if (hand.pots && hand.pots.some((p) => p.awarded && p.eligible.length > 1)) throw userError('Part of this pot is already paid out — use Undo instead.');
  // Take back anything auto-returned at showdown, then refund the full commitment.
  for (const [id, amt] of Object.entries(hand.results || {})) { const p = player(room, id); if (p) p.stack = r2(p.stack - amt); }
  for (const id of hand.order) {
    const p = player(room, id);
    if (p) p.stack = r2(p.stack + hand.seats[id].committed);
  }
  room.nextDealerId = hand.dealerId;
  room.handNo -= 1;
  room.hand = null;
  room.log(`Hand #${hand.no} cancelled — all bets returned.`);
  room.purgeLeft();
}

/** A player leaves or is removed mid-hand: fold them and keep the hand moving. */
function forceFold(room, pid) {
  const hand = room.hand;
  if (!hand || !hand.seats[pid] || hand.seats[pid].folded) return;
  const seat = hand.seats[pid];
  seat.folded = true;
  seat.acted = true;
  if (hand.street === 'showdown') {
    for (const pot of hand.pots) {
      if (pot.awarded) continue;
      pot.eligible = pot.eligible.filter((id) => id !== pid);
      if (pot.eligible.length === 1) payPot(room, pot, [pot.eligible[0]], false);
    }
    if (hand.pots.every((p) => p.awarded)) finishHand(room);
    return;
  }
  progress(room, pid, false);
}

function publicHand(hand) {
  if (!hand) return null;
  return {
    no: hand.no, street: hand.street, dealerId: hand.dealerId, sbId: hand.sbId, bbId: hand.bbId,
    order: hand.order, seats: hand.seats, currentBet: hand.currentBet, lastRaise: hand.lastRaise,
    toActId: hand.toActId, pots: hand.pots, runout: hand.runout, potTotal: potTotal(hand),
  };
}

module.exports = { startHand, act, award, abort, forceFold, calcPots, potTotal, publicHand };
