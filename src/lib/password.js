'use strict';
const crypto = require('node:crypto');

const KEYLEN = 64;
const OPTS = { N: 16384, r: 8, p: 1 };

function hash(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const key = crypto.scryptSync(password, salt, KEYLEN, OPTS).toString('hex');
  return `scrypt$${salt}$${key}`;
}

function verify(password, stored) {
  const [algo, salt, key] = String(stored || '').split('$');
  if (algo !== 'scrypt' || !salt || !key) return false;
  const expected = Buffer.from(key, 'hex');
  const actual = crypto.scryptSync(password, salt, KEYLEN, OPTS);
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}

/** Tối thiểu 8 ký tự, có chữ và số */
function isStrong(password) {
  return typeof password === 'string' && password.length >= 8 && /[A-Za-z]/.test(password) && /\d/.test(password);
}

module.exports = { hash, verify, isStrong };
