import { Elysia } from 'elysia';
import { resolve } from 'node:path';
import { prisma } from '../db';
import { ledgerAuthorized, ledgerSatang, receiptPhotoPaths, validSince } from '../ledger-feed';

// A complete read-only snapshot, not a payment API. An isolated service token
// grants ONLY these routes; it is never accepted by the normal session routes.
// A full snapshot also represents withdrawal/rejection (receipts unbundled by
// those routes). Fail rather than return a truncated snapshot that looks final.
export const ledgerFeedRoutes = new Elysia({ prefix: '/ledger-feed' })
  .onBeforeHandle(({ headers, status, set }) => {
    set.headers['cache-control'] = 'no-store';
    if (!ledgerAuthorized(headers.authorization)) return status(401, { error: 'unauthorized' });
  })
  .get('/receipts', async ({ query, status }) => {
    const since = query.since;
    if (!validSince(since)) return status(400, { error: 'invalid since' });
    const receipts = await prisma.receipt.findMany({
      where: { bundle: { submittedAt: { gte: new Date(since) }, status: { in: ['PENDING', 'APPROVED', 'PAYING', 'PAID'] } } },
      orderBy: { id: 'asc' }, take: 5001,
      include: {
        user: { select: { name: true } }, files: { orderBy: { position: 'asc' } },
        bundle: { include: { receipts: { select: { amount: true } } } },
      },
    });
    if (receipts.length > 5000) return status(503, { error: 'snapshot limit exceeded' });
    const items = receipts.map(r => {
      const b = r.bundle!;
      return {
        id: r.id, bundleId: b.id, status: b.status, submittedAt: b.submittedAt.toISOString(),
        paidAt: b.paidAt?.toISOString() ?? null,
        paymentMatchesReceipts: b.status !== 'PAID' || (b.transferAmount !== null
          && ledgerSatang(b.transferAmount) === b.receipts.reduce((n, x) => n + ledgerSatang(x.amount), 0)),
        merchant: r.merchant, claimant: r.user.name, category: r.category, property: r.property,
        amountSatang: ledgerSatang(r.amount), date: r.date, note: r.note ?? '',
        photoCount: receiptPhotoPaths(r).length,
      };
    });
    return { version: 1, complete: true, since, generatedAt: new Date().toISOString(), items };
  })
  .get('/receipts/:id/photos/:index', async ({ params, status }) => {
    if (!/^\d+$/.test(params.index)) return status(404, 'Not found');
    const receipt = await prisma.receipt.findFirst({
      where: { id: params.id, bundle: { status: { in: ['PENDING', 'APPROVED', 'PAYING', 'PAID'] } } },
      include: { files: { orderBy: { position: 'asc' } } },
    });
    if (!receipt) return status(404, 'Not found');
    const path = receiptPhotoPaths(receipt)[Number(params.index)];
    // Only generated local upload names, never an arbitrary URL/path from a caller.
    if (!path || !/^\/uploads\/[A-Za-z0-9_-]+\.(?:jpg|jpeg|png|webp)$/i.test(path)) return status(404, 'Not found');
    const file = Bun.file(resolve(process.cwd(), 'uploads', path.slice('/uploads/'.length)));
    if (!(await file.exists())) return status(404, 'Not found');
    return file;
  });
