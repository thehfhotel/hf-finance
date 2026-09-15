import { timingSafeEqual, createHash } from 'node:crypto';

export function ledgerAuthorized(header: string | undefined, token = process.env.LEDGER_FEED_TOKEN ?? ''): boolean {
  if (!token || !header) return false;
  const digest = (s: string) => createHash('sha256').update(s).digest();
  return timingSafeEqual(digest(header), digest(`Bearer ${token}`));
}

export function validSince(value: string | undefined): value is string {
  return !!value && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
    && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}

/** Decimal text to integer satang: never multiply a floating-point baht value. */
export function ledgerSatang(value: { toString(): string }): number {
  const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(value.toString());
  if (!match) throw new Error('Invalid receipt amount');
  const amount = Number(match[1]) * 100 + Number((match[2] ?? '').padEnd(2, '0'));
  if (!Number.isSafeInteger(amount) || amount < 0) throw new Error('Invalid receipt amount');
  return amount;
}

export function receiptPhotoPaths(receipt: { photoPath: string | null; files: { photoPath: string }[] }): string[] {
  return receipt.files.length ? receipt.files.map(f => f.photoPath) : receipt.photoPath ? [receipt.photoPath] : [];
}
