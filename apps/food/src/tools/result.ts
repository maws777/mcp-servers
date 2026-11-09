// Tool results: structured data for the client, plus the same as text for
// clients that only read text. Errors are returned as tool errors
// (isError), not thrown: Claude sees the message and can fix its call
// (e.g. re-check numbers that failed the energy check).

export function ok(data: Record<string, unknown>) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data) }],
    structuredContent: data,
  };
}

export function fail(message: string) {
  return {
    content: [{ type: "text" as const, text: message }],
    isError: true,
  };
}
