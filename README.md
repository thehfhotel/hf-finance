# payroll

Internal payroll-form web app for an in-house HR/finance workflow.
Generates beneficiary and transfer xlsx files in the K BIZ (KBank Business
Online) format, and ships a companion browser-automation worker
(`kbiz-bot`) that uploads them to K BIZ on a schedule.

This repository is published for transparency. It is **not** a generally
licensed open-source project — see `LICENSE` for the terms under which
the source is made available.

## Components

| dir | role |
| --- | --- |
| `src/` | Bun + Elysia web app (port 3000). Account list, monthly payroll worksheet, OTP-gated approvals queue, xlsx generation. |
| `kbiz-bot/` | Playwright + Chromium worker. Persistent K BIZ session, uploads beneficiary lists and payroll batches, polls the queue. |

## Payroll to expense ledger

The private-token endpoint `GET /api/ledger-feed/payroll?since=<UTC ISO instant>`
provides a complete snapshot of submitted payroll batches after a fixed cutoff.
Set `PAYROLL_LEDGER_FEED_TOKEN` through the existing deployment pipeline to enable
it. The response contains request identity, payroll month, scheduled date, net
transfer total in integer satang, recipient count and verified payment status;
it contains no names, account numbers or individual salaries.

Queue `done` means the upload finished, not that salaries settled. The feed keeps
such batches scheduled/unpaid until a matching verified bank result proves full
settlement. The status and approvals pages display this distinction in Thai.
The ledger files one net-pay summary per run, then settles that same row on the
verified bank payment date. Raw editable worksheets are not exported as final
payroll. Historical submissions are excluded by the ledger's fixed activation
time, and historical manual salary entries are not reconciled automatically.

## Running locally

```sh
bun install
cp .env.example .env   # fill in KBIZ_USERNAME / KBIZ_PASSWORD / SLACK_WEBHOOK_URL
bun run start          # web app only
```

For the full stack (web + browser-bot), use docker-compose:

```sh
docker compose up -d --build
docker compose logs -f
```

## Deployment

Production runs on a single host (evergreen). CI/CD details — including
the SSH-over-cloudflared deploy pattern, forced-command on the deploy
user, and one-time evergreen setup — are documented in
[`EVERGREEN.md`](./EVERGREEN.md).

## Security

See [`SECURITY.md`](./SECURITY.md).

## License

See [`LICENSE`](./LICENSE). Reading for security review, study, or
evaluation is permitted; use, modification, and redistribution are not.
