'use strict';
const crypto = require('crypto');

/** Error whose message is safe to show to the player who caused it. */
function userError(msg) {
  const e = new Error(msg);
  e.user = true;
  return e;
}

const r2 = (x) => Math.round((x + Number.EPSILON) * 100) / 100;
const uid = (n = 8) => crypto.randomBytes(n).toString('hex');

/** Parse a client-supplied number; throws a user error if it is out of range. */
function num(v, { min = 0, max = 1e9, int = false, name = 'Amount' } = {}) {
  const n = typeof v === 'string' ? Number(v) : v;
  if (typeof n !== 'number' || !Number.isFinite(n)) throw userError(`${name} must be a number.`);
  if (int && !Number.isInteger(n)) throw userError(`${name} must be a whole number.`);
  if (n < min) throw userError(`${name} must be at least ${min}.`);
  if (n > max) throw userError(`${name} can be at most ${max}.`);
  return int ? n : r2(n);
}

function cleanName(v) {
  const s = String(v == null ? '' : v).replace(/[\u0000-\u001f<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, 16);
  if (!s) throw userError('Enter a name first.');
  return s;
}

const fmt = (n) => {
  const v = r2(n);
  return Number.isInteger(v) ? v.toLocaleString('en-US') : v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
};

module.exports = { userError, r2, uid, num, cleanName, fmt };
