// Spike 1: can claude.ai reach a Lambda MCP server through Cognito OAuth?
//
// One Lambda behind an API Gateway HTTP API serves three things:
//
//   GET  /.well-known/oauth-protected-resource[/mcp]
//        RFC 9728 metadata: "my tokens come from this authorization server
//        (the Cognito user pool), with these scopes". Public, no token.
//
//   POST /mcp without a valid token
//        401 + WWW-Authenticate pointing at the metadata above. This is what
//        starts the OAuth flow in the client.
//
//   POST /mcp with a valid token
//        A real MCP server (official SDK v2) with one tool, `whoami`, that
//        returns the user ID taken from the token.
//
// Throwaway code: the real server reuses the token check, not this file.

import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from "aws-lambda";
import { CognitoJwtVerifier } from "aws-jwt-verify";
import { McpServer, createMcpHandler, type AuthInfo } from "@modelcontextprotocol/server";
import { z } from "zod";

const REGION = mustEnv("AWS_REGION");
const USER_POOL_ID = mustEnv("USER_POOL_ID");
const CLIENT_IDS = mustEnv("CLIENT_IDS").split(","); // app clients allowed to call this server
const READ_SCOPE = mustEnv("READ_SCOPE"); // e.g. mcp-food/food:read
const WRITE_SCOPE = mustEnv("WRITE_SCOPE");
const ISSUER = `https://cognito-idp.${REGION}.amazonaws.com/${USER_POOL_ID}`;
const AS_MODE = mustEnv("AS_MODE"); // "cognito" (plan A) or "shim" (plan B), see infra/variables.tf
const LOGIN_BASE_URL = mustEnv("LOGIN_BASE_URL"); // Cognito managed login domain

// Created once per Lambda container, outside the handler, so the user pool's
// public keys (JWKS) are downloaded on the first request and then cached for
// every later request this container serves.
//
// What verify() checks, and why each check matters:
// - signature, against the pool's public keys: the token really comes from
//   this Cognito pool and wasn't modified;
// - iss = this pool: a token from another pool (even another AWS customer's)
//   is refused;
// - exp: expired tokens are refused;
// - token_use = "access": an ID token (meant for the client app, not for
//   APIs) is refused;
// - client_id in CLIENT_IDS and scope contains READ_SCOPE: the scope is
//   prefixed with this server's URL (the resource server identifier), so a
//   token for another app in the same pool doesn't carry it.
// Plus, in the handler: `aud`, when present, must be this server's URL.
// Cognito access tokens normally have no `aud`; with resource binding
// (RFC 8707 `resource` parameter) it is expected to be set. The spike logs
// which one we get.
const verifier = CognitoJwtVerifier.create({
  userPoolId: USER_POOL_ID,
  tokenUse: "access",
  clientId: CLIENT_IDS,
  scope: READ_SCOPE,
});

// The MCP endpoint. createMcpHandler serves both protocol eras: 2026-07-28
// (stateless, version in every request) and 2025-era clients that start with
// `initialize` (answered statelessly too). A fresh McpServer is built per
// request by the factory, which is what makes it fit Lambda: nothing has to
// survive between requests.
const mcp = createMcpHandler(
  ({ authInfo }) => {
    // The user ID comes from the verified token, captured here, never from
    // tool arguments. A tool can't be tricked into acting for someone else.
    const sub = String(authInfo?.extra?.sub ?? "");
    const server = new McpServer({ name: "food-auth-spike", version: "0.1.0" });

    server.registerTool(
      "whoami",
      {
        title: "Who am I",
        description: "Returns the signed-in user's ID and granted scopes. Spike tool to test sign-in.",
        inputSchema: z.object({}),
        annotations: { readOnlyHint: true },
      },
      async () => {
        const result = { sub, scopes: authInfo?.scopes ?? [], clientId: authInfo?.clientId };
        return {
          content: [{ type: "text", text: JSON.stringify(result) }],
          structuredContent: result,
        };
      },
    );
    return server;
  },
  // No streaming: API Gateway HTTP APIs buffer the whole response anyway.
  { responseMode: "json", onerror: (e) => log("mcp_error", { message: e.message }) },
);

export async function handler(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyStructuredResultV2> {
  const host = event.requestContext.domainName;
  const method = event.requestContext.http.method;
  const path = event.rawPath;
  const resource = `https://${host}/mcp`; // this server's canonical URI (RFC 8707)
  const metadataUrl = `https://${host}/.well-known/oauth-protected-resource/mcp`;

  log("request", {
    method,
    path,
    hasAuth: Boolean(event.headers.authorization),
    protocolVersion: event.headers["mcp-protocol-version"],
    userAgent: event.headers["user-agent"],
  });

  // Plan B: our own RFC 8414 authorization server metadata. Same Cognito
  // endpoints as Cognito's own discovery document, plus the PKCE
  // advertisement Cognito leaves out (and that MCP clients must check).
  // The issuer is this host, because a client checks that the metadata's
  // `issuer` equals the URL it derived it from. Tokens still come from (and
  // are verified against) Cognito; the client never validates the access
  // token's own `iss`.
  if (method === "GET" && path === "/.well-known/oauth-authorization-server") {
    if (AS_MODE !== "shim") return json(404, { error: "not_found" });
    return json(200, {
      issuer: `https://${host}`,
      authorization_endpoint: `${LOGIN_BASE_URL}/oauth2/authorize`,
      token_endpoint: `${LOGIN_BASE_URL}/oauth2/token`,
      revocation_endpoint: `${LOGIN_BASE_URL}/oauth2/revoke`,
      jwks_uri: `${ISSUER}/.well-known/jwks.json`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none"],
      scopes_supported: [READ_SCOPE, WRITE_SCOPE],
    });
  }

  if (method === "GET" && path.startsWith("/.well-known/oauth-protected-resource")) {
    return json(200, {
      resource,
      authorization_servers: [AS_MODE === "shim" ? `https://${host}` : ISSUER],
      scopes_supported: [READ_SCOPE, WRITE_SCOPE],
      bearer_methods_supported: ["header"],
      resource_name: "Food tracker (auth spike)",
    });
  }

  if (path !== "/mcp") return json(404, { error: "not_found" });

  // Every MCP request must carry a valid token. Missing or invalid -> 401
  // with the challenge that tells the client where to find the metadata.
  const challenge = (error?: string) =>
    `Bearer resource_metadata="${metadataUrl}", scope="${READ_SCOPE} ${WRITE_SCOPE}"` +
    (error ? `, error="${error}"` : "");

  const header = event.headers.authorization ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  if (!token) {
    log("auth", { result: "missing_token" });
    return json(401, { error: "unauthorized" }, { "www-authenticate": challenge() });
  }

  let authInfo: AuthInfo;
  try {
    const payload = await verifier.verify(token);
    const rawAud = (payload as { aud?: string | string[] }).aud;
    const aud = rawAud === undefined ? [] : Array.isArray(rawAud) ? rawAud : [rawAud];
    if (aud.length > 0 && !aud.includes(resource)) {
      throw new Error(`audience mismatch: ${aud.join(",")}`);
    }
    log("auth_claims", { aud, audPresent: aud.length > 0 });
    authInfo = {
      token,
      clientId: payload.client_id,
      scopes: payload.scope?.split(" ") ?? [],
      expiresAt: payload.exp,
      extra: { sub: payload.sub },
    };
    log("auth", { result: "ok", sub: payload.sub, clientId: payload.client_id, scopes: authInfo.scopes });
  } catch (e) {
    // Never log the token itself: it's a password for an hour.
    log("auth", { result: "invalid_token", reason: (e as Error).message });
    return json(401, { error: "invalid_token" }, { "www-authenticate": challenge("invalid_token") });
  }

  const response = await mcp.fetch(toRequest(event), { authInfo });
  return fromResponse(response);
}

// --- API Gateway event <-> web-standard Request/Response -------------------

function toRequest(event: APIGatewayProxyEventV2): Request {
  const query = event.rawQueryString ? `?${event.rawQueryString}` : "";
  const url = `https://${event.requestContext.domainName}${event.rawPath}${query}`;
  const headers = new Headers();
  for (const [k, v] of Object.entries(event.headers)) if (v !== undefined) headers.set(k, v);
  const body =
    event.body === undefined ? undefined : event.isBase64Encoded ? Buffer.from(event.body, "base64") : event.body;
  return new Request(url, { method: event.requestContext.http.method, headers, body });
}

async function fromResponse(res: Response): Promise<APIGatewayProxyStructuredResultV2> {
  const headers: Record<string, string> = {};
  res.headers.forEach((v, k) => (headers[k] = v));
  return { statusCode: res.status, headers, body: await res.text() };
}

function json(statusCode: number, body: unknown, headers: Record<string, string> = {}) {
  return { statusCode, headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) };
}

function log(event: string, data: Record<string, unknown>) {
  console.log(JSON.stringify({ event, ...data }));
}

function mustEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`missing env ${name}`);
  return v;
}
