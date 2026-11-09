# Spike 2: iPhone home-screen PWA → Cognito login → back into the app

Question: can the dashboard, installed on an iPhone home screen as a PWA, sign
in through Cognito managed login (another domain) and land back *inside the
installed app* with its PKCE state intact, then stay signed in across
restarts (refresh token, rotation)?

The classic iOS pitfall: out-of-scope navigation from a standalone PWA opens
in an overlay, and some iOS versions finished the redirect in Safari, which
doesn't share storage with the home-screen app. The page logs the display
mode (`standalone` / `browser`) at every step.

**Status: answered, stack destroyed 2026-11-09** (with spike 1).

## What it deploys (staging)

| Resource | Why |
|---|---|
| S3 bucket `mcp-pwa-spike-<account>` | Site files. Private: only the CloudFront distribution can read it (origin access control) |
| CloudFront distribution | HTTPS on `*.cloudfront.net`, no caching (spike), security headers: strict CSP, HSTS, `X-Frame-Options: DENY`, `no-referrer` |
| Cognito client `mcp-pwa-spike-web` | Public, PKCE, refresh token rotation, **`food:read` only**, callback = the site URL |

Cost: free (CloudFront always-free tier, S3 cents).

## Run it

Prerequisite: spike 1 applied (its resource server provides the read scope).

```powershell
cd spikes/02-pwa-login/infra
terraform init -backend-config=../../../infra/staging/shared/backend.hcl
terraform plan -out=tfplan
terraform apply tfplan
terraform output site_url
```

On the iPhone: open `site_url` in Safari → Share → Add to Home Screen →
open the app from the home screen → Se connecter.

## Checked before the phone test (2026-11-08)

- Security headers served on every response (CSP, HSTS, frame, referrer, nosniff).
- Direct S3 access refused (403); only CloudFront reads the bucket.
- Cognito's `/oauth2/token` answers the CORS preflight from the site origin, so the browser can redeem the code itself.
- Page renders with no CSP violation; "Se connecter" reaches the managed login page.

## Results (2026-11-08)

**It works.** Installed from Safari on an iPhone (user agent: iOS 18.7), the
home-screen app signed in through Cognito managed login (password + TOTP) and
came back into the installed app, signed in, with the read-only token.

Evidence, from the staging account's CloudTrail (Cognito records managed
login and token endpoint calls as events, with secrets redacted):

| Time (UTC) | Event | Detail |
|---|---|---|
| 22:32:21 | `OAuth2_Authorize_GET` | iPhone, start of login |
| 22:33:38 | `login_POST` | password step |
| 22:33:54 | `mfa_totp_POST` | TOTP step |
| 22:33:55 | `Token_POST` | `grant_type=authorization_code` **with `code_verifier`**, client `mcp-pwa-spike-web`, 200 |
| 22:34:11 | `Token_POST` | `grant_type=refresh_token`, 200 (rotation enabled on the client) |

The code exchange succeeding with the verifier means the callback ran in a
context that could read the localStorage written when the login started: the
iOS pitfall (redirect finishing in Safari, PKCE state lost) did not happen.

Rotation chain verified 2026-11-09: two refreshes in a row, the second with
the refresh token returned by the first, both 200. Not observed: the page's
own "refresh on open when expired" trigger (app code, to test in the real
dashboard).

Consequences for the real dashboard:

- Plain authorization code + PKCE from the browser works; no backend-for-
  frontend needed for the login. Cognito's token endpoint allows CORS.
- Its own public client, `food:read` only, refresh token rotation.
- CSP as tested here (`script-src 'self'`, `connect-src` limited to the API
  and the Cognito domain, no inline script) works with this flow.
- The landing zone's CI apply role has no CloudFront or app-bucket
  permissions yet: a landing-zone PR is needed before the dashboard deploys
  through CI.
- Tokens in localStorage are readable by any script on the origin: the CSP is
  what keeps that safe. Decide for the real app (ADR): localStorage + strict
  CSP, or tokens in memory + refresh token in localStorage.
