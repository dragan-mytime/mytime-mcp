import { optionalEnv, requireEnv } from "@mytime/shared";

/** Send the digest email via the Resend API. Recipients/sender come from env. */
export async function sendDigestEmail(mail: { subject: string; html: string }): Promise<void> {
  const key = requireEnv("RESEND_API_KEY");
  const from = optionalEnv("DIGEST_FROM") ?? "MY:TIME BI <digest@mytimeprime.mk>";
  const to = (optionalEnv("DIGEST_RECIPIENTS") ?? "dragan@mytime.mk")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ from, to, subject: mail.subject, html: mail.html }),
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) {
    throw new Error(`Resend HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }
}
