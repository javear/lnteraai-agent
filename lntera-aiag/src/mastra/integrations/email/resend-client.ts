// Resend transactional email client (REST-only, matching the plain-fetch client convention already
// used for other external services — see onesignal/push.ts, studio/edgeone.ts). Config (env):
//   RESEND_API_KEY   – secret key from https://resend.com/api-keys
//   RESEND_FROM_EMAIL – verified sender, e.g. "Lntera <reports@yourdomain.com>" (Resend requires the
//                       domain to be verified in their dashboard before it can send from it)
import { logErrorBrief } from '../../logger/compact-error';

const RESEND_API = 'https://api.resend.com/emails';

export interface SendEmailInput {
  to: string;
  subject: string;
  html: string;
  text: string;
}

function resendConfig(): { apiKey: string; from: string } | null {
  const apiKey = process.env.RESEND_API_KEY?.trim();
  const from = process.env.RESEND_FROM_EMAIL?.trim();
  if (!apiKey || !from) return null;
  return { apiKey, from };
}

export function emailConfigured(): boolean {
  return resendConfig() !== null;
}

/** Best-effort — returns false (never throws) on missing config or a send failure, so a flaky email
 *  provider never breaks the caller's own success path (matches sendTenantPush's contract). */
export async function sendEmail(input: SendEmailInput): Promise<boolean> {
  const cfg = resendConfig();
  if (!cfg) return false;

  try {
    const res = await fetch(RESEND_API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.apiKey}` },
      body: JSON.stringify({
        from: cfg.from,
        to: [input.to],
        subject: input.subject,
        html: input.html,
        text: input.text,
      }),
    });
    if (!res.ok) {
      logErrorBrief(`[email] send failed (${res.status}) to=${input.to}`, await safeText(res));
      return false;
    }
    return true;
  } catch (err) {
    logErrorBrief(`[email] send threw to=${input.to}`, err);
    return false;
  }
}

async function safeText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return '';
  }
}
