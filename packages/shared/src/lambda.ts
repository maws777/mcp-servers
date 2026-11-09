// The Lambda entry shared by every MCP server: routing, auth, and handing the
// request to the app's MCP handler. An app only supplies its config and its
// McpServer factory.
//
//   GET  /.well-known/oauth-protected-resource[/mcp]  RFC 9728 metadata (public)
//   *    /mcp                                         token check, then MCP
//
// Anything else never reaches the Lambda: API Gateway only has these routes.

import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from "aws-lambda";
import { createMcpHandler, type McpServerFactory } from "@modelcontextprotocol/server";
import { createTokenVerifier, issuerUrl, type AuthConfig } from "./auth";
import { fromResponse, json, toRequest } from "./http";
import { log } from "./log";

export interface McpLambdaConfig extends AuthConfig {
  /** Shown to users in client UIs. */
  resourceName: string;
}

export function createMcpLambda(config: McpLambdaConfig, factory: McpServerFactory) {
  const { verify, warmup } = createTokenVerifier(config);
  const issuer = issuerUrl(config.region, config.userPoolId);
  const resourceUrl = new URL(config.resource);
  const metadataUrl = `${resourceUrl.origin}/.well-known/oauth-protected-resource${resourceUrl.pathname}`;

  const mcp = createMcpHandler(factory, {
    responseMode: "json", // API Gateway HTTP APIs buffer responses: no streaming
    onerror: (e) => log("mcp_error", { message: e.message }),
  });

  // The challenge that starts OAuth in the client: where the metadata is,
  // and which scopes to ask for.
  const challenge = (error?: string) =>
    `Bearer resource_metadata="${metadataUrl}", scope="${config.scopes.join(" ")}"` +
    (error ? `, error="${error}"` : "");

  async function handler(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyStructuredResultV2> {
    const method = event.requestContext.http.method;
    const path = event.rawPath;
    const started = Date.now();

    if (method === "GET" && path.startsWith("/.well-known/oauth-protected-resource")) {
      return json(200, {
        resource: config.resource,
        authorization_servers: [issuer],
        scopes_supported: config.scopes,
        bearer_methods_supported: ["header"],
        resource_name: config.resourceName,
      });
    }

    if (path !== resourceUrl.pathname) return json(404, { error: "not_found" });

    const auth = await verify(event.headers.authorization);
    if (!auth.ok) {
      log("auth_failed", { error: auth.error, reason: auth.reason });
      const error = auth.error === "invalid_token" ? "invalid_token" : undefined;
      return json(401, { error: auth.error }, { "www-authenticate": challenge(error) });
    }

    const { token } = auth;
    const call = describeCall(event);
    const response = await mcp.fetch(toRequest(event), {
      authInfo: {
        token: token.token,
        clientId: token.clientId,
        scopes: token.scopes,
        expiresAt: token.expiresAt,
        resource: resourceUrl,
        resourceMetadataUrl: metadataUrl,
        extra: { sub: token.sub },
      },
    });

    const result = await fromResponse(response);
    log("request", {
      ...call,
      status: response.status,
      outcome: outcomeOf(response.status, result.body ?? ""),
      ms: Date.now() - started,
      clientId: token.clientId,
      protocolVersion: event.headers["mcp-protocol-version"],
    });
    return result;
  }

  /** Preloads what the first request would otherwise fetch. Never throws: a failure just means the first request fetches it. */
  async function prepare(): Promise<void> {
    const started = Date.now();
    try {
      await warmup();
      log("warmup", { ms: Date.now() - started });
    } catch (e) {
      log("warmup_failed", { message: (e as Error).message });
    }
  }

  return { handler, prepare };
}

// --- What to log about an MCP call, without its content ----------------------

/** JSON-RPC method and, for tools/call, the tool name. Never the arguments. */
function describeCall(event: APIGatewayProxyEventV2): { rpc?: string; tool?: string } {
  try {
    const raw = event.isBase64Encoded ? Buffer.from(event.body ?? "", "base64").toString() : (event.body ?? "");
    const msg = JSON.parse(raw) as { method?: string; params?: { name?: string } };
    return { rpc: msg.method, tool: msg.method === "tools/call" ? msg.params?.name : undefined };
  } catch {
    return {};
  }
}

/**
 * ok, tool_error (the tool answered with isError: a validation refusal, an
 * unknown ID), rpc_error (protocol-level error), or http_<status>. Reads only
 * those flags from the response, never its content.
 */
function outcomeOf(status: number, body: string): string {
  if (status === 202) return "accepted"; // notification
  if (status !== 200) return `http_${status}`;
  // Legacy (2025) clients get SSE framing: "event: message\ndata: {...}".
  const jsonText = body.startsWith("event:") ? (body.split("\n").find((l) => l.startsWith("data:"))?.slice(5) ?? "") : body;
  try {
    const msg = JSON.parse(jsonText) as { error?: unknown; result?: { isError?: boolean } };
    if (msg.error) return "rpc_error";
    if (msg.result?.isError) return "tool_error";
    return "ok";
  } catch {
    return "unknown";
  }
}

/** The user ID for a request: the verified token's `sub`, put there by createMcpLambda. */
export function userIdFrom(authInfo: { extra?: Record<string, unknown> } | undefined): string {
  const sub = authInfo?.extra?.sub;
  if (typeof sub !== "string" || sub.length === 0) throw new Error("no authenticated user");
  return sub;
}
