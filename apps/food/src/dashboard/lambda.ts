// Lambda entry for the dashboard API, mcp-food-<env>-dashboard.
//
// A separate function from the MCP server on purpose: its role can only
// read the table (GetItem, Query), so a bug or a crafted request on this
// path can't write anything. And it accepts only the dashboard's Cognito
// client, while the MCP server accepts only claude.ai's: a token from one
// can't be used on the other.
//
// The browser reaches it through CloudFront (same origin as the page):
// https://food.<env>.lab.michaelteplov.com/api/... -> API Gateway -> here.

import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from "aws-lambda";
import { createTokenVerifier, json, log } from "@mcp/shared";
import { handleApi } from "./api";

function env(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`missing env ${name}`);
  return v;
}

const resource = env("RESOURCE"); // the MCP URL: the dashboard's tokens carry it as aud too
const { verify, warmup } = createTokenVerifier({
  region: env("AWS_REGION"),
  userPoolId: env("USER_POOL_ID"),
  clientIds: [env("DASHBOARD_CLIENT_ID")],
  resource,
  scopes: [`${resource}/food:read`],
});

// Diet data: never cached by the browser or CloudFront.
const NO_STORE = { "cache-control": "no-store" };

export async function handler(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyStructuredResultV2> {
  const started = Date.now();
  const route = event.rawPath;

  if (event.requestContext.http.method !== "GET") return json(405, { error: "method_not_allowed" }, NO_STORE);

  const auth = await verify(event.headers.authorization);
  if (!auth.ok) {
    log("auth_failed", { route, error: auth.error, reason: auth.reason });
    return json(401, { error: auth.error }, { ...NO_STORE, "www-authenticate": "Bearer" });
  }

  try {
    const result = await handleApi(auth.token.sub, route, new URLSearchParams(event.rawQueryString ?? ""));
    log("api", { route, status: result.status, ms: Date.now() - started });
    return json(result.status, result.body, NO_STORE);
  } catch (e) {
    log("api_error", { route, message: (e as Error).message, ms: Date.now() - started });
    return json(500, { error: "internal_error" }, NO_STORE);
  }
}

// Cognito's public keys, fetched during init (see src/lambda.ts).
try {
  await warmup();
} catch (e) {
  log("warmup_failed", { message: (e as Error).message });
}
