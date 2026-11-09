// Sign-in for the dashboard: authorization code + PKCE, straight from the
// browser to Cognito (spike 2 showed it works from the iPhone home-screen
// app, and Cognito's token endpoint allows CORS).
//
// Token storage (ADR 0001): the access token only in this module's memory,
// the refresh token in localStorage so the app stays signed in across
// restarts. The CSP is what keeps foreign script from reading it.
//
// Every request also sends `resource` = the MCP URL (RFC 8707): Cognito then
// puts it in the token's `aud`, which the API requires.

export interface Config {
  loginBaseUrl: string;
  clientId: string;
  scope: string;
  resource: string;
  redirectUri: string;
}

const KEYS = { pkce: "food.pkce", refresh: "food.refresh" };
let access: { token: string; exp: number } | null = null;

function base64url(bytes: ArrayBuffer | Uint8Array): string {
  let s = "";
  for (const b of new Uint8Array(bytes)) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

const randomString = (n: number) => base64url(crypto.getRandomValues(new Uint8Array(n)));

function expiryOf(token: string): number {
  const part = token.split(".")[1]!.replace(/-/g, "+").replace(/_/g, "/");
  return (JSON.parse(atob(part)) as { exp: number }).exp * 1000;
}

function storage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

async function tokenRequest(cfg: Config, params: Record<string, string>) {
  const res = await fetch(`${cfg.loginBaseUrl}/oauth2/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: cfg.clientId, resource: cfg.resource, ...params }),
  });
  const body = (await res.json().catch(() => ({}))) as { access_token?: string; refresh_token?: string; error?: string };
  if (!res.ok || !body.access_token) throw new Error(`token endpoint: ${res.status} ${body.error ?? ""}`.trim());
  return body as { access_token: string; refresh_token?: string };
}

function keep(tokens: { access_token: string; refresh_token?: string }) {
  access = { token: tokens.access_token, exp: expiryOf(tokens.access_token) };
  // With rotation, each refresh returns a new refresh token; the old one dies.
  if (tokens.refresh_token) storage()?.setItem(KEYS.refresh, tokens.refresh_token);
}

/** Sends the user to Cognito's login page. */
export async function login(cfg: Config): Promise<void> {
  // PKCE: a random verifier kept here, its SHA-256 sent to Cognito. Only
  // whoever holds the verifier can redeem the code that comes back.
  const verifier = randomString(64);
  const challenge = base64url(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
  const state = randomString(16);
  storage()?.setItem(KEYS.pkce, JSON.stringify({ verifier, state }));

  const url = new URL(`${cfg.loginBaseUrl}/oauth2/authorize`);
  url.search = new URLSearchParams({
    response_type: "code",
    client_id: cfg.clientId,
    redirect_uri: cfg.redirectUri,
    scope: cfg.scope,
    resource: cfg.resource,
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
  }).toString();
  location.assign(url.toString());
}

/** If this page load is Cognito's redirect back, redeems the code. Returns an error message, or null. */
export async function handleCallback(cfg: Config): Promise<string | null> {
  const params = new URLSearchParams(location.search);
  if (!params.has("code") && !params.has("error")) return null;
  history.replaceState(null, "", "/"); // the code leaves the address bar and history at once

  if (params.has("error")) return `Connexion refusée : ${params.get("error")}`;
  const raw = storage()?.getItem(KEYS.pkce);
  storage()?.removeItem(KEYS.pkce); // single use
  const pkce = raw ? (JSON.parse(raw) as { verifier: string; state: string }) : null;
  if (!pkce || pkce.state !== params.get("state")) return "Connexion interrompue, recommence.";

  try {
    keep(await tokenRequest(cfg, { grant_type: "authorization_code", code: params.get("code")!, redirect_uri: cfg.redirectUri, code_verifier: pkce.verifier }));
    return null;
  } catch {
    return "Connexion refusée par Cognito, recommence.";
  }
}

/** A valid access token, refreshing it if needed; null when a login is needed. */
export async function accessToken(cfg: Config, { force = false } = {}): Promise<string | null> {
  if (!force && access && access.exp > Date.now() + 60_000) return access.token;
  const refresh = storage()?.getItem(KEYS.refresh);
  if (!refresh) return null;
  try {
    keep(await tokenRequest(cfg, { grant_type: "refresh_token", refresh_token: refresh }));
    return access!.token;
  } catch {
    // Expired or revoked (or reused: rotation refuses an old one).
    storage()?.removeItem(KEYS.refresh);
    access = null;
    return null;
  }
}

export function logout(cfg: Config): void {
  access = null;
  storage()?.removeItem(KEYS.refresh);
  const url = new URL(`${cfg.loginBaseUrl}/logout`);
  url.search = new URLSearchParams({ client_id: cfg.clientId, logout_uri: cfg.redirectUri }).toString();
  location.assign(url.toString());
}
