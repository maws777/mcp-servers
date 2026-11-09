# 1. Dashboard tokens: access token in memory, refresh token in localStorage

Date: 2026-11-09

Status: accepted

## Context

The food dashboard (`docs/design/food-dashboard.md`) is a static site on my
iPhone's home screen that signs in with Cognito (authorization code + PKCE,
from the browser; spike 2) and calls `/api` with a bearer token. It must
stay signed in across app restarts, for weeks: re-entering a password and a
TOTP code every hour would make it unusable.

What the browser holds:

- an **access token**, 60 minutes, `food:read` only;
- a **refresh token**, 30 days, rotated: each use returns a new one and the
  old one stops working.

Home-screen apps on iOS are exempt from Safari's 7-day deletion of script-
writable storage, so `localStorage` survives (spike 2).

Options:

- **A. Both tokens in `localStorage`.** Simplest. Any script running on the
  origin can read both.
- **B. Access token in memory, refresh token in `localStorage`.** On each
  app open, the refresh token gets a fresh access token, which lives only in
  a JavaScript variable. A script on the origin can still read the refresh
  token.
- **C. Backend for frontend.** A Lambda does the code exchange and keeps
  tokens server-side; the browser gets an `HttpOnly` cookie that scripts
  can't read. Needs a session store, CSRF protection, and a cookie path
  through CloudFront.

All three fall to the same thing: script running on the origin (XSS). With
C, that script can't steal a token, but it can still call `/api` with the
cookie while the page is open. So the real defence in every option is not
letting foreign script run at all.

## Decision

**B.** Access token in memory, refresh token in `localStorage`, behind:

- a strict CSP (`script-src 'self'`, no inline script, no `eval`, no
  third-party origins; `connect-src` only the site and the Cognito domain);
- text-only rendering of anything from the API, checked in CI;
- no third-party JavaScript and no framework in the page.

## Consequences

Good:

- No server-side session: nothing to store, expire or protect against CSRF
  (a bearer token in a header isn't sent automatically, unlike a cookie).
- What a stolen refresh token gives is limited: read-only data, and rotation
  means the next refresh by either the thief or me invalidates the other's
  copy; I'd notice being signed out, and Cognito can revoke the token.

Costs and risks:

- XSS that gets past the CSP can read the refresh token and keep reading my
  diet data for up to 30 days (GDPR Article 9 health data). Accepted for a
  single-user app; C is the upgrade if the dashboard ever gains write
  access or other users.
- Phase 4c needs a write (registering the phone for push). It gets its own
  narrow scope, `food:devices`, so this reasoning (a stolen token can't
  change food data) still holds.
