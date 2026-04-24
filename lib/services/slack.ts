/**
 * Minimal Slack webhook notifier for batch + uploader lifecycle events.
 *
 * No-ops silently when SLACK_WEBHOOK_URL is unset so dev/local runs aren't
 * noisy. Never throws — a Slack hiccup must never block tenant processing or
 * upload work. Each failure logs to stderr and moves on.
 */

const WEBHOOK_URL = process.env.SLACK_WEBHOOK_URL || "";

export type SlackLevel = "info" | "warn" | "error";

const LEVEL_PREFIX: Record<SlackLevel, string> = {
  info: "",
  warn: ":warning: ",
  error: ":rotating_light: "
};

export async function slackNotify(
  message: string,
  level: SlackLevel = "info"
): Promise<void> {
  if (!WEBHOOK_URL) return;

  const text = `${LEVEL_PREFIX[level]}${message}`;

  try {
    const resp = await fetch(WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text })
    });
    if (!resp.ok) {
      console.error(`[Slack] webhook returned ${resp.status}: ${await resp.text().catch(() => "")}`);
    }
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error(`[Slack] webhook threw: ${msg}`);
  }
}
