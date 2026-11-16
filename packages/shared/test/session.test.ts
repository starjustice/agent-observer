import { describe, expect, it } from 'vitest';
import { SESSION_TTL_MS } from '../src/constants';
import { createSessionValue, safeEqual, sessionSecret, verifySessionValue } from '../src/session';

const secret = sessionSecret({ VIEWER_PASSWORD: 'correct horse' });

describe('viewer session cookie', () => {
  it('accepts its own value and rejects a different secret', () => {
    const value = createSessionValue(secret, 1000);
    expect(verifySessionValue(value, secret, 2000)).toBe(true);
    expect(verifySessionValue(value, sessionSecret({ VIEWER_PASSWORD: 'other' }), 2000)).toBe(false);
  });

  it('rejects expired, tampered and missing values', () => {
    const value = createSessionValue(secret, 1000);
    expect(verifySessionValue(value, secret, 1000 + SESSION_TTL_MS + 1)).toBe(false);
    const [expiry, mac] = value.split('.');
    expect(verifySessionValue(`${Number(expiry) + 1}.${mac}`, secret, 2000)).toBe(false);
    for (const bad of [undefined, '', 'abc', '.', `${expiry}.`, `.${mac}`]) {
      expect(verifySessionValue(bad, secret, 2000)).toBe(false);
    }
  });

  it('compares strings safely', () => {
    expect(safeEqual('abc', 'abc')).toBe(true);
    expect(safeEqual('abc', 'abd')).toBe(false);
    expect(safeEqual('abc', 'abcd')).toBe(false);
  });
});
