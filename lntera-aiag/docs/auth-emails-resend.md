# Auth emails via Resend + Supabase (dashboard setup)

The app now uses **Supabase-native** auth flows, so all auth emails go through Supabase's SMTP.
Point that SMTP at **Resend** and brand the templates — then signup confirmation codes, passwordless
login codes, and password-reset links all send from your domain.

> Code changes are already shipped. The steps below are **dashboard config only** (no deploy needed),
> but the flows won't work until they're done.

## 1. Resend
1. In Resend, **verify your sending domain** (add the DNS records). Use a from-address on it, e.g.
   `no-reply@lntera.ai`.
2. Copy a Resend **API key** (`re_...`). It's used as the SMTP password.

## 2. Supabase -> Authentication -> Emails -> SMTP Settings -> "Enable Custom SMTP"
| Field | Value |
| --- | --- |
| Host | `smtp.resend.com` |
| Port | `465` (SSL) — or `587` |
| Username | `resend` |
| Password | your Resend API key (`re_...`) |
| Sender email | `no-reply@lntera.ai` (must be on the verified domain) |
| Sender name | `Lntera` |

## 3. Supabase -> Authentication settings
- **Confirm email: ON** (Providers -> Email). Required for the new signup confirmation step. With it
  OFF, signup silently logs in (the old behavior) and no code is sent.
- **Email OTP** stays enabled (default with the Email provider) — powers passwordless login.
- **OTP / code expiry**: set the **Email OTP Expiration** to e.g. `600` (10 min) if you want it
  shorter than the 1-hour default. This governs both the signup code and the login code.
- **URL Configuration**
  - **Site URL**: your canonical frontend, e.g. `https://lntera.ai/app`.
  - **Redirect URLs** (allowlist) — needed for the password-reset link:
    - `https://lntera.ai/app/reset-password`
    - `https://lnteraai-mastra-production.up.railway.app/app/reset-password`
    - `http://localhost:4111/app/reset-password` (local testing)
    - (a wildcard like `https://lntera.ai/app/**` also works)

## 4. Branded email templates (Supabase -> Authentication -> Email Templates)
Ready-to-paste HTML lives in **`docs/email-templates/`**. For each Supabase template: open the file,
copy ALL of it, paste into the template body, and set the subject. Supabase fills in the variables —
`{{ .Token }}` is the 6-digit code, `{{ .ConfirmationURL }}` is the reset link.

| Supabase template | Paste this file | Suggested subject |
| --- | --- | --- |
| **Confirm signup** | `docs/email-templates/confirm-signup.html` | `Confirm your email · Lntera` |
| **Magic Link** (passwordless **login** code uses this one) | `docs/email-templates/login-code.html` | `Your Lntera sign-in code` |
| **Reset Password** | `docs/email-templates/reset-password.html` | `Reset your Lntera password` |

Notes:
- The **Magic Link** template is what `signInWithOtp` (our "Sign in with an email code") uses — with
  `{{ .Token }}` it shows the 6-digit code instead of a link.
- **Reset Password** intentionally uses the **link** (`{{ .ConfirmationURL }}` -> `/reset-password`), not a code.
- They're plain inline-styled HTML (orange `#dc4a1e`, light card — email-client-safe, no external
  CSS/SVG). Open a file in a browser to preview; tweak copy/colors freely.

## What the code now does
- **Signup**: `supabase.auth.signUp(...)` -> if a session comes back (Confirm email OFF) the user is in;
  otherwise the UI shows a 6-digit **confirmation** step (`verifyOtp` type `signup`). Workspace name
  rides in user metadata and is provisioned on first authenticated session (same path as Google).
- **Passwordless login**: "Sign in with an email code" -> `signInWithOtp({ shouldCreateUser:false })`
  -> 6-digit code -> `verifyOtp` type `email`. Expiry is Supabase-managed (step 3).
- **Password recovery**: emails the reset **link** -> `/reset-password`; a global recovery gate opens
  the set-password form instead of logging the user in (fixes the "auto-logged-in" bug, incl. Google
  users, who get to *set* a password).
