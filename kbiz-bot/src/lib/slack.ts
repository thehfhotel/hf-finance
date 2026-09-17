/**
 * The bot's one Slack voice. Every line the bot posts — the QR handoff's, the
 * queue loop's — goes through this helper, so they share one set of
 * fire-and-forget semantics: a webhook that is unset, slow or broken must
 * never turn a bank flow into a crash.
 *
 * No playwright, no fs: the queue loop and the pure-ish halves of the login
 * path both import it, and root CI runs `bun test` before kbiz-bot's
 * node_modules exist.
 */

const SLACK = process.env.SLACK_WEBHOOK_URL;

/** Unset `SLACK_WEBHOOK_URL` is a no-op; a failed POST is swallowed. */
export async function notifySlack(text: string): Promise<void> {
  if (!SLACK) return;
  try {
    await fetch(SLACK, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text }),
    });
  } catch {}
}
