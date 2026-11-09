// API Gateway (HTTP API, payload v2) event <-> web-standard Request/Response.
// The MCP SDK speaks Request/Response; Lambda speaks events. Keeping the
// server code on Request/Response means the same code can later run behind
// the Lambda Web Adapter or on Fargate with a plain HTTP server.

import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from "aws-lambda";

export function toRequest(event: APIGatewayProxyEventV2): Request {
  const query = event.rawQueryString ? `?${event.rawQueryString}` : "";
  const url = `https://${event.requestContext.domainName}${event.rawPath}${query}`;
  const headers = new Headers();
  for (const [k, v] of Object.entries(event.headers)) if (v !== undefined) headers.set(k, v);
  const body =
    event.body === undefined ? undefined : event.isBase64Encoded ? Buffer.from(event.body, "base64") : event.body;
  return new Request(url, { method: event.requestContext.http.method, headers, body });
}

export async function fromResponse(res: Response): Promise<APIGatewayProxyStructuredResultV2> {
  const headers: Record<string, string> = {};
  res.headers.forEach((v, k) => (headers[k] = v));
  return { statusCode: res.status, headers, body: await res.text() };
}

export function json(
  statusCode: number,
  body: unknown,
  headers: Record<string, string> = {},
): APIGatewayProxyStructuredResultV2 {
  return { statusCode, headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) };
}
