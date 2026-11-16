// The one model call: Claude Haiku 5.5 on Bedrock, through the `eu.`
// inference profile (Paris has no in-region endpoint; the profile keeps the
// call in six EU regions, landing-zone ADR 0014).
//
// AnthropicBedrock goes through bedrock-runtime InvokeModel, the IAM action
// the boundary and the region SCP's exception allow. Structured outputs
// (output_config.format) constrain the answer to OutputSchema, so there's no
// free text to parse.

import AnthropicBedrock from "@anthropic-ai/bedrock-sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { OutputSchema, SYSTEM_PROMPT, userMessage } from "./prompt";
import type { SummaryContext } from "./context";

export interface ModelResult {
  output: unknown;
  stop_reason: string | null;
  input_tokens: number;
  output_tokens: number;
}

export type InvokeModel = (ctx: SummaryContext) => Promise<ModelResult>;

export function bedrockModel(modelId: string, region: string): InvokeModel {
  // apiKey: null = sign with the Lambda role's credentials, never a bearer key.
  const client = new AnthropicBedrock({ awsRegion: region, apiKey: null, maxRetries: 1, timeout: 45_000 });
  return async (ctx) => {
    const res = await client.messages.parse({
      model: modelId,
      max_tokens: 2000, // room for the (adaptive) thinking; the answer itself is short
      // Short commentary on precomputed numbers: low effort is enough.
      output_config: { effort: "low", format: zodOutputFormat(OutputSchema) },
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: userMessage(ctx) }],
    });
    return {
      output: res.stop_reason === "end_turn" ? res.parsed_output : null,
      stop_reason: res.stop_reason,
      input_tokens: res.usage.input_tokens,
      output_tokens: res.usage.output_tokens,
    };
  };
}
