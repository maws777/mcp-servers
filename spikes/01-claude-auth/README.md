# Spike 1: claude.ai → Cognito → Lambda MCP server

Question this spike answers: can claude.ai sign in to a remote MCP server whose
authorization server is a Cognito user pool, using a pre-registered public
client, and can the server validate Cognito's access tokens (which have no
`aud` claim)?

Throwaway: destroyed once answered. What survives is the user pool
(`infra/staging/shared`) and the token-validation approach.

## What it deploys (staging account)

| Resource | Why |
|---|---|
| Cognito resource server `mcp-food` | Identifier = the MCP URL (resource binding), scopes `<url>/food:read` and `<url>/food:write` |
| Cognito app client `mcp-food-auth-spike-claude` | Public client (PKCE, no secret), callback `https://claude.ai/api/mcp/auth_callback` |
| Lambda `mcp-food-auth-spike` | Protected resource metadata, 401 challenge, MCP server with a `whoami` tool |
| API Gateway HTTP API | Public HTTPS endpoint, throttled (10 req/s, burst 20) |
| IAM role `/mcp/mcp-food-auth-spike` | Logs only, with the platform permissions boundary |

Cost: free at this volume (Lambda, API Gateway and Cognito free tiers).

## Run it

Prerequisite: `infra/staging/shared` applied (the user pool).

```powershell
cd spikes/01-claude-auth
npm ci
npm run build
cd infra
terraform init -backend-config=../../../infra/staging/shared/backend.hcl
terraform plan -out=tfplan
terraform apply tfplan
terraform output
```

Then in claude.ai: Settings → Connectors → Add custom connector, URL =
`mcp_url`, advanced settings → OAuth Client ID = `claude_client_id` (no
secret). Connect, sign in, ask Claude to call `whoami`.

Logs: `aws logs tail /aws/lambda/mcp-food-auth-spike --follow --profile staging-admin`
(each request logs its path, whether it carried a token and the validation
result, never the token).

## Results (2026-11-08)

**It works.** claude.ai connected with the pre-registered client, I signed in
on Cognito managed login (new password + TOTP), and `whoami` returned my `sub`,
the client ID and both scopes.

What the logs and probes showed:

1. **Discovery.** Cognito answers only the third URL the MCP spec makes
   clients try (`<issuer>/.well-known/openid-configuration`); the RFC 8414 and
   OIDC path-insertion URLs return 400. Its document lacks
   `code_challenge_methods_supported`, which the spec says should make clients
   refuse. claude.ai went ahead anyway, so plan B (`as_metadata_mode = "shim"`,
   our own RFC 8414 metadata) was not needed. Kept in the code in case a
   stricter client (Claude Code, a future claude.ai) enforces it.
2. **Resource binding (RFC 8707).** Cognito supports the `resource`
   parameter: it grants custom scopes only if their resource server identifier
   equals the requested resource, else `invalid_request`. With identifier
   `mcp-food` the login would have failed. Fix: **resource server identifier =
   the MCP server URL**. A foreign `resource` is refused.
3. **`aud` is present.** With resource binding, Cognito access tokens carry
   `aud = <MCP server URL>`. The server can (and the real one will) require it,
   on top of `client_id` and scope.
4. **Refresh token rotation** (required by the MCP spec for public clients)
   is incompatible with `ALLOW_REFRESH_TOKEN_AUTH`; the client uses
   `ALLOW_USER_SRP_AUTH` only, refreshes go through `/oauth2/token`.
5. **Protocol.** claude.ai probes unauthenticated with `MCP-Protocol-Version:
   2025-11-25` (user agent `python-httpx`), then, once it has a token, talks
   **2026-07-28** (user agent `Claude-User`). The SDK v2 dual-era handler
   served both.
6. Unknown paths are answered 404 by API Gateway without invoking the Lambda.

Not yet verified: the refresh after the 1-hour access token expiry.

Consequences for the real server:

- Give it its custom domain (`food.mcp.staging.lab.michaelteplov.com`) from
  day one: the resource server identifier and the scope names are its URL.
- Token check: signature, `iss`, `exp`, `token_use = access`, `client_id`
  allow-list, scope, and `aud` required.
- Reuse: one Cognito pool per environment, one resource server + one client
  per app and per caller (claude.ai, dashboard).
