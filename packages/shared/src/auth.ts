// Access token check for every MCP server in this repo.
//
// What a token must satisfy (findings of spike 1, spikes/01-claude-auth):
// - signature against the Cognito pool's public keys (JWKS, fetched once per
//   Lambda container and cached): it really comes from our pool, unmodified;
// - iss = our pool, exp in the future, token_use = "access";
// - client_id in the allow-list of app clients for this server;
// - at least one of this server's scopes (each tool then requires its own);
// - aud = this server's URL. Cognito sets it because clients send the RFC
//   8707 `resource` parameter and the resource server identifier is this
//   URL ("resource binding"). Required: a token issued for another server,
//   even from the same pool, is refused.
//
// The user is the token's `sub`, and only that: tools never take a user ID.

import { CognitoJwtVerifier } from "aws-jwt-verify";

export interface AuthConfig {
  region: string;
  userPoolId: string;
  clientIds: string[];
  /** This server's canonical URL, e.g. https://food.mcp.staging.lab.michaelteplov.com/mcp */
  resource: string;
  scopes: string[];
}

export interface VerifiedToken {
  token: string;
  sub: string;
  clientId: string;
  scopes: string[];
  expiresAt: number;
}

export type AuthResult =
  | { ok: true; token: VerifiedToken }
  | { ok: false; error: "missing_token" | "invalid_token"; reason: string };

export function issuerUrl(region: string, userPoolId: string): string {
  return `https://cognito-idp.${region}.amazonaws.com/${userPoolId}`;
}

export function createTokenVerifier(config: AuthConfig) {
  const verifier = CognitoJwtVerifier.create({
    userPoolId: config.userPoolId,
    tokenUse: "access",
    clientId: config.clientIds,
    scope: config.scopes, // at least one of them
  });

  /**
   * Downloads the pool's public keys now instead of on the first token.
   * Called during the Lambda's init phase (top-level await in the entry), so
   * the download overlaps the container start instead of adding to the
   * first request's latency.
   */
  async function warmup(): Promise<void> {
    await verifier.hydrate();
  }

  async function verify(authorizationHeader: string | undefined): Promise<AuthResult> {
    const header = authorizationHeader ?? "";
    const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
    if (!token) return { ok: false, error: "missing_token", reason: "no bearer token" };

    try {
      const payload = await verifier.verify(token);
      const rawAud = (payload as { aud?: string | string[] }).aud;
      const aud = rawAud === undefined ? [] : Array.isArray(rawAud) ? rawAud : [rawAud];
      if (!aud.includes(config.resource)) {
        return { ok: false, error: "invalid_token", reason: `audience ${aud.join(",") || "(none)"} is not this server` };
      }
      return {
        ok: true,
        token: {
          token,
          sub: payload.sub,
          clientId: payload.client_id,
          scopes: payload.scope?.split(" ") ?? [],
          expiresAt: payload.exp,
        },
      };
    } catch (e) {
      return { ok: false, error: "invalid_token", reason: (e as Error).message };
    }
  }

  return { verify, warmup };
}
