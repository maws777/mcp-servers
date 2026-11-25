// The one model call, through Bedrock's Converse API: the same request shape
// for every model on Bedrock, so which model runs is configuration (MODEL_ID,
// MODEL_REGION), not code.
//
// Today: Qwen3 235B, on demand in Stockholm, chosen by the summary eval
// (apps/food/eval, landing-zone ADR 0017; DeepSeek V3.2 before it, ADR 0015).
// Open weights hosted by AWS in that region: the prompt stays in the EU and
// never reaches the model's publisher. Claude Haiku 5.5 gets evaluated once
// the account's quota for it isn't 0.
//
// Structured output: one tool, `write_summary`, whose input schema is the
// answer, and toolChoice forcing it. The tool is never executed; it only
// makes the model return JSON in that shape instead of free text.

import { BedrockRuntimeClient, ConverseCommand } from "@aws-sdk/client-bedrock-runtime";
import { SYSTEM_PROMPT, userMessage } from "./prompt";
import type { SummaryContext } from "./context";

export interface ModelResult {
  output: unknown;
  stop_reason: string | null;
  input_tokens: number;
  output_tokens: number;
}

export type InvokeModel = (ctx: SummaryContext) => Promise<ModelResult>;

const TOOL = "write_summary";

const outputSchema = {
  type: "object",
  properties: {
    resume: { type: "string", description: "2 ou 3 phrases sur la journée." },
    conseil: { type: "string", description: "Un seul conseil concret." },
    note: { type: "string", description: "Journée terminée : une ligne pour toi-même. Sinon, chaîne vide." },
  },
  required: ["resume", "conseil", "note"],
  additionalProperties: false,
};

export function bedrockModel(modelId: string, region: string): InvokeModel {
  const client = new BedrockRuntimeClient({ region, maxAttempts: 2 });
  return async (ctx) => {
    const res = await client.send(
      new ConverseCommand({
        modelId,
        system: [{ text: SYSTEM_PROMPT }],
        messages: [{ role: "user", content: [{ text: userMessage(ctx) }] }],
        inferenceConfig: { maxTokens: 800 },
        toolConfig: {
          tools: [{ toolSpec: { name: TOOL, description: "Écrit le mot du jour.", inputSchema: { json: outputSchema } } }],
          toolChoice: { tool: { name: TOOL } },
        },
      }),
      { abortSignal: AbortSignal.timeout(45_000) },
    );
    const call = res.output?.message?.content?.find((b) => b.toolUse?.name === TOOL)?.toolUse;
    return {
      output: res.stopReason === "tool_use" ? (call?.input ?? null) : null,
      stop_reason: res.stopReason ?? null,
      input_tokens: res.usage?.inputTokens ?? 0,
      output_tokens: res.usage?.outputTokens ?? 0,
    };
  };
}
