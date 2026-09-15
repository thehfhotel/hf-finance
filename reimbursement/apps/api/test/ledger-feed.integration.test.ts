import { beforeAll, afterAll, describe, test, expect } from 'bun:test';
const TEST_DB = process.env.TEST_DATABASE_URL;
if (TEST_DB) process.env.DATABASE_URL = TEST_DB;
(TEST_DB ? describe : describe.skip)('receipt feed (database)', () => {
  let prisma: (typeof import('../src/db'))['prisma'];
  let routes: (typeof import('../src/routes/ledger-feed'))['ledgerFeedRoutes'];
  let userId: string, bundleId: string, receiptId: string;
  const since = '2099-01-01T00:00:00.000Z';
  const oldToken = process.env.LEDGER_FEED_TOKEN;
  const read = (auth = 'Bearer feed-test') => routes.handle(new Request(`http://localhost/ledger-feed/receipts?since=${since}`, { headers: { authorization: auth } }));
  beforeAll(async () => {
    ({ prisma } = await import('../src/db')); ({ ledgerFeedRoutes: routes } = await import('../src/routes/ledger-feed'));
    process.env.LEDGER_FEED_TOKEN = 'feed-test';
    userId = (await prisma.user.create({ data: { name: 'ทดสอบ', initials: 'ทด' } })).id;
    bundleId = (await prisma.bundle.create({ data: { userId, name: 'ตัวอย่าง', status: 'PENDING', submittedAt: new Date(since) } })).id;
    for (let i = 0; i < 2; i++) receiptId = (await prisma.receipt.create({ data: { userId, bundleId, merchant: 'ทดสอบ', category: 'อื่น ๆ', amount: '0.29', date: '2099-01-01' } })).id;
    await prisma.receipt.create({ data: { userId, merchant: 'ใบเสร็จยังไม่ส่ง', category: 'อื่น ๆ', amount: '99', date: '2099-01-01' } });
  });
  afterAll(async () => {
    if (userId) await prisma.user.delete({ where: { id: userId } });
    if (oldToken === undefined) delete process.env.LEDGER_FEED_TOKEN; else process.env.LEDGER_FEED_TOKEN = oldToken;
  });
  test('unauthorized requests cannot read the feed or photos', async () => {
    expect((await read('Bearer wrong')).status).toBe(401);
    expect((await routes.handle(new Request(`http://localhost/ledger-feed/receipts/${receiptId}/photos/0`))).status).toBe(401);
  });
  test('one request exports every receipt separately and excludes unsent receipts', async () => {
    const res = await read(); expect(res.status).toBe(200);
    const body = await res.json() as any; expect(body.complete).toBe(true); expect(body.items).toHaveLength(2);
    expect(body.items.every((r: any) => r.status === 'PENDING' && r.amountSatang === 29 && r.bundleId === bundleId)).toBe(true);
  });
  test('paid update and transfer mismatch are reflected without a second source row', async () => {
    await prisma.bundle.update({ where: { id: bundleId }, data: { status: 'PAID', paidAt: new Date(since), transferAmount: '0.58' } });
    let body = await (await read()).json() as any; expect(body.items).toHaveLength(2); expect(body.items.every((r: any) => r.status === 'PAID' && r.paymentMatchesReceipts)).toBe(true);
    await prisma.bundle.update({ where: { id: bundleId }, data: { transferAmount: '1' } });
    body = await (await read()).json(); expect(body.items.every((r: any) => !r.paymentMatchesReceipts)).toBe(true);
  });
  test('unbundling removes receipts from the complete snapshot', async () => {
    await prisma.receipt.updateMany({ where: { bundleId }, data: { bundleId: null } });
    expect((await (await read()).json() as any).items).toEqual([]);
  });
});
