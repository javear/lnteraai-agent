# Auth emails via Resend + Supabase (dashboard setup)

The app now uses **Supabase-native** auth flows, so all auth emails go through Supabase's SMTP.
Point that SMTP at **Resend** and brand the templates — then signup confirmation codes, passwordless
login codes, and password-reset links all send from your domain.

> Code changes are already shipped. The steps below are **dashboard config only** (no deploy needed),
> but the flows won't work until they're done.

## 1. Resend
1. In Resend, **verify your sending domain** (add the DNS records). Use a from-address on it, e.g.
   `no-reply@lntera.ai`.
2. Copy a Resend **API key** (`re_…`). It's used as the SMTP password.

## 2. Supabase → Authentication → Emails → SMTP Settings → "Enable Custom SMTP"
| Field | Value |
| --- | --- |
| Host | `smtp.resend.com` |
| Port | `465` (SSL) — or `587` |
| Username | `resend` |
| Password | your Resend API key (`re_…`) |
| Sender email | `no-reply@lntera.ai` (must be on the verified domain) |
| Sender name | `Lntera` |

## 3. Supabase → Authentication settings
- **Confirm email: ON** (Providers → Email). Required for the new signup confirmation step. With it
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

## 4. Branded email templates (Supabase → Authentication → Email Templates)
`{{ .Token }}` renders the **6-digit code**; `{{ .ConfirmationURL }}` renders the reset **link**.

### "Confirm signup"  — subject: `Your Lntera confirmation code`
```html
<table width="100%" cellpadding="0" cellspacing="0" style="background:#f5f5f4;padding:32px 0;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif">
  <tr><td align="center">
    <table width="440" cellpadding="0" cellspacing="0" style="background:#fff;border:1px solid #e7e5e4;border-radius:14px;padding:36px 40px">
      <tr><td style="padding-bottom:24px">
        <span style="display:inline-block;width:30px;height:30px;background:#dc4a1e;border-radius:8px;color:#fff;font-weight:700;text-align:center;line-height:30px;font-size:16px;vertical-align:middle">L</span>
        <span style="font-size:16px;font-weight:600;color:#1c1917;vertical-align:middle;margin-left:8px">Lntera</span>
      </td></tr>
      <tr><td style="font-size:21px;font-weight:600;color:#1c1917;padding-bottom:8px">Confirm your email</td></tr>
      <tr><td style="font-size:14px;line-height:1.6;color:#57534e;padding-bottom:24px">Enter this code to finish creating your Lntera account:</td></tr>
      <tr><td align="center" style="padding-bottom:24px">
        <div style="font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:34px;font-weight:700;letter-spacing:10px;color:#1c1917;background:#fafaf9;border:1px solid #e7e5e4;border-radius:10px;padding:16px 0">{{ .Token }}</div>
      </td></tr>
      <tr><td style="font-size:12px;line-height:1.6;color:#a8a29e">This code expires shortly. If you didn't sign up for Lntera, you can safely ignore this email.</td></tr>
    </table>
  </td></tr>
</table>
```

### "Magic Link"  (this template is what passwordless **login** uses) — subject: `Your Lntera sign-in code`
Same markup as above, with the heading/body swapped:
```html
<tr><td style="font-size:21px;font-weight:600;color:#1c1917;padding-bottom:8px">Your sign-in code</td></tr>
<tr><td style="font-size:14px;line-height:1.6;color:#57534e;padding-bottom:24px">Use this code to sign in to Lntera:</td></tr>
<!-- …same {{ .Token }} code box… -->
<tr><td style="font-size:12px;line-height:1.6;color:#a8a29e">This code expires shortly. If you didn't try to sign in, you can ignore this email.</td></tr>
```

### "Reset Password" (recovery) — subject: `Reset your Lntera password`  (uses a LINK, not a code)
```html
<table width="100%" cellpadding="0" cellspacing="0" style="background:#f5f5f4;padding:32px 0;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif">
  <tr><td align="center">
    <table width="440" cellpadding="0" cellspacing="0" style="background:#fff;border:1px solid #e7e5e4;border-radius:14px;padding:36px 40px">
      <tr><td style="padding-bottom:24px">
        <span style="display:inline-block;width:30px;height:30px;background:#dc4a1e;border-radius:8px;color:#fff;font-weight:700;text-align:center;line-height:30px;font-size:16px;vertical-align:middle">L</span>
        <span style="font-size:16px;font-weight:600;color:#1c1917;vertical-align:middle;margin-left:8px">Lntera</span>
      </td></tr>
      <tr><td style="font-size:21px;font-weight:600;color:#1c1917;padding-bottom:8px">Reset your password</td></tr>
      <tr><td style="font-size:14px;line-height:1.6;color:#57534e;padding-bottom:24px">Click below to set a new password. If you didn't request this, ignore this email.</td></tr>
      <tr><td align="center" style="padding-bottom:24px">
        <a href="{{ .ConfirmationURL }}" style="display:inline-block;background:#dc4a1e;color:#fff;font-size:15px;font-weight:600;text-decoration:none;padding:12px 28px;border-radius:9px">Reset password</a>
      </td></tr>
      <tr><td style="font-size:12px;line-height:1.6;color:#a8a29e">Or paste this link:<br><span style="color:#78716c;word-break:break-all">{{ .ConfirmationURL }}</span><br><br>This link expires shortly.</td></tr>
    </table>
  </td></tr>
</table>
```

## What the code now does
- **Signup**: `supabase.auth.signUp(...)` → if a session comes back (Confirm email OFF) the user is in;
  otherwise the UI shows a 6-digit **confirmation** step (`verifyOtp` type `signup`). Workspace name
  rides in user metadata and is provisioned on first authenticated session (same path as Google).
- **Passwordless login**: "Sign in with an email code" → `signInWithOtp({ shouldCreateUser:false })`
  → 6-digit code → `verifyOtp` type `email`. Expiry is Supabase-managed (step 3).
- **Password recovery**: emails the reset **link** → `/reset-password`; a global recovery gate opens
  the set-password form instead of logging the user in (fixes the "auto-logged-in" bug, incl. Google
  users, who get to *set* a password).
