# Payroll verification scheduling (2026-09-16)

## Automatic operation

The queue watcher still scans local files every 30 seconds so approved payroll
and reimbursement work stays responsive. This is NOT a bank login interval.
The bank is opened only for real approved queue work or a due payroll check.
No general bank-transaction synchronization has been added.

`PAYROLL_BANK_VERIFY_SINCE` retains its existing meaning: a fixed, canonical UTC
lower bound on eligible payroll submissions. Missing/invalid disables payroll
verification, including manual backfills. It is not a recurring backfill switch.
No deployment variable or secret changes are required for the new defaults.

Automatic bank checks run only for unarchived, submitted, unresolved payroll:

- Not before the effective pay date at Bangkok midnight (or actual submission
  start, if later). Uploads scheduled ahead of payday are quiet until due.
- One check when first due, then at most once every **6 hours per run**. The
  existing private `payrollVerification.checkedAt` survives process restarts
  and throttles bank/session failures as well as successful reads.
- Stop for persisted settlement proof or the matcher's confirmed
  `FAILED / BANK_FAILED` verdict. A queue-level `failed` is not bank proof.
- Automatic retries stop **7 days after the later of the pay date or submission
  start**. Older unresolved history is manual-only; it is never marked paid or
  rewritten as a confirmed failure simply because the checking window expired.

Several due runs share one serialized bank session. A newly submitted, due run
can trigger its first check independently of another run's six-hour cooldown.
No eligible run means no bank session. Future-dated payroll is not polled.

The existing payment-priority and arm-lock guards still apply before every
check. All queue AND archive records remain available to the exact-data matcher
for reference/filename ownership, even if outside the automatic checking window.
Recipient matching, settlement proof, transfer handling, phone approval and
reimbursement behavior are unchanged. Unknown results remain unresolved; the
scheduler never retries a payment.

## Explicit one-shot historical backfill

Use the running bot's command below, from the existing payroll compose directory:

```sh
docker compose exec -T kbiz-bot node --import tsx src/request-payroll-bank-backfill.ts
```

To request only one immutable payroll request ID:

```sh
docker compose exec -T kbiz-bot node --import tsx src/request-payroll-bank-backfill.ts --request-id SAMPLE_REQUEST_ID
```

This command only publishes a control file. It does NOT open Chromium, log into
the bank, submit a transfer, or start a second worker. The existing queue watcher
performs one read-only pass when approved/running work and the arm lock are clear.
It uses the configured `PAYROLL_BANK_VERIFY_SINCE` scope and still excludes
archived, settled, bank-confirmed-failed and future-dated requests. An unknown
target ID consumes the request with no bank access, never broadens its scope.

The request is atomically published as `.payroll-bank-backfill.request` in the
shared queue. A second pending request is rejected, not silently overwritten.
The worker renames it to `.payroll-bank-backfill.claimed` BEFORE accessing the
bank. These non-`.json` control files cannot be interpreted as payment intents.
The claimed file records the last accepted manual request, not completion or
payment proof. Existing per-run verification fields/logs show the result.

A bank outage or worker crash does not replay historical backfills. Queue another
explicit request to retry a historical pass. Current runs still retain their
normal six-hour automatic policy. Requests remain pending while verification is
disabled or payments/approval locks prevent a safe read.

## Validation and deployment

The policy tests cover Bangkok boundaries, six-hour persistence, the seven-day
limit, terminal outcomes, invalid data and explicit backfill eligibility. The
checker integration tests use private temporary fixture files and an injected
bank reader: they prove zero bank reads for idle/future/old runs, one-shot
consumption before access, lock/queue deferral, outage throttling, exact archived
reference checks and rejection of stale proof when request data changes.
No test logs into the real bank or contains real employee/payment details.

Use the existing `.github/workflows/deploy.yml` pipeline: PR tests/typecheck,
then merge to main to build the K BIZ image and deploy through evergreen's
existing serialized SSH/compose deployment. Do not change bank credentials,
queue mounts, transfer flows, or deployment concurrency for this scheduling fix.
