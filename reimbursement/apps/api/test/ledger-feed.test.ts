import { test, expect } from 'bun:test';
import { ledgerAuthorized, ledgerSatang, receiptPhotoPaths, validSince } from '../src/ledger-feed';
test('feed auth fails closed and is not a normal session token', () => {
  expect(ledgerAuthorized('Bearer sample', '')).toBe(false);
  expect(ledgerAuthorized('Bearer wrong', 'sample')).toBe(false);
  expect(ledgerAuthorized(undefined, 'sample')).toBe(false);
  expect(ledgerAuthorized('Bearer sample', 'sample')).toBe(true);
});
test('decimal money and activation time preserve exact values', () => {
  expect(ledgerSatang('1234.56')).toBe(123456); expect(ledgerSatang('0.29')).toBe(29);
  for (const v of ['1.001', '-1', 'NaN']) expect(() => ledgerSatang(v)).toThrow();
  expect(validSince('2026-02-30T00:00:00.000Z')).toBe(false);
  expect(validSince('2026-09-15T00:00:00.000Z')).toBe(true);
});
test('every receipt attachment is preserved; legacy cover remains accessible', () => {
  expect(receiptPhotoPaths({ photoPath: '/uploads/a.jpg', files: [{ photoPath: '/uploads/a.jpg' }, { photoPath: '/uploads/b.jpg' }] })).toEqual(['/uploads/a.jpg', '/uploads/b.jpg']);
  expect(receiptPhotoPaths({ photoPath: '/uploads/a.jpg', files: [] })).toEqual(['/uploads/a.jpg']);
});
