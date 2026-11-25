// The models compared, called exactly as the summary Lambda calls them
// (bedrockModel: Converse, forced tool call, same prompt).
//
// Which ones: every text model the staging account could call on 2026-11-25
// with a forced tool call, inside the region SCP (six EU regions, ADR 0014):
// open-weight models on demand in their EU region, and `eu.` cross-region
// profiles. Not here: `global.` profiles (denied by the SCP: they route outside
// the EU), and models Bedrock refuses for this account ("not available for
// this account": Claude 5.x, GPT-6, Grok, GLM; the same quota-0 cause as
// Haiku 5.5, ADR 0015). Haiku 5.5 is listed so the report says it didn't run.
//
// Prices: US dollars per million tokens, input / output, from the AWS Price
// List API on 2026-11-25, in the region the call is made from (for `eu.`
// profiles, Paris).

export interface EvalModel {
  key: string;
  label: string;
  modelId: string;
  region: string;
  price: { input: number; output: number };
}

export const MODELS: EvalModel[] = [
  { key: "deepseek", label: "DeepSeek V3.2 (production)", modelId: "deepseek.v3.2", region: "eu-north-1", price: { input: 0.74, output: 2.22 } },
  { key: "qwen", label: "Qwen3 235B 2507", modelId: "qwen.qwen3-235b-a22b-2507-v1:0", region: "eu-north-1", price: { input: 0.22, output: 0.88 } },
  { key: "ministral", label: "Ministral 3 14B", modelId: "mistral.ministral-3-14b-instruct", region: "eu-west-1", price: { input: 0.23, output: 0.23 } },
  { key: "sonnet46", label: "Claude Sonnet 4.6", modelId: "eu.anthropic.claude-sonnet-4-6", region: "eu-west-3", price: { input: 3.3, output: 16.5 } },
  { key: "haiku45", label: "Claude Haiku 4.5", modelId: "eu.anthropic.claude-haiku-4-5-20251001-v1:0", region: "eu-west-3", price: { input: 1.1, output: 5.5 } },
  { key: "novapro", label: "Amazon Nova Pro", modelId: "eu.amazon.nova-pro-v1:0", region: "eu-west-3", price: { input: 1.18, output: 4.72 } },
  { key: "nova2lite", label: "Amazon Nova 2 Lite", modelId: "eu.amazon.nova-2-lite-v1:0", region: "eu-west-3", price: { input: 0.484, output: 4.059 } },
  { key: "gptoss120", label: "gpt-oss-120b", modelId: "openai.gpt-oss-120b-1:0", region: "eu-west-1", price: { input: 0.18, output: 0.7 } },
  { key: "minimax", label: "MiniMax M2", modelId: "minimax.minimax-m2", region: "eu-west-1", price: { input: 0.35, output: 1.41 } },
  { key: "gemma27", label: "Gemma 3 27B", modelId: "google.gemma-3-27b-it", region: "eu-west-1", price: { input: 0.27, output: 0.45 } },
  { key: "qwennext", label: "Qwen3 Next 80B", modelId: "qwen.qwen3-next-80b-a3b", region: "eu-west-1", price: { input: 0.168, output: 1.44 } },
  // Blocked until the account's quota for it is raised (ADR 0015).
  { key: "haiku", label: "Claude Haiku 5.5", modelId: "eu.anthropic.claude-haiku-5-5", region: "eu-west-3", price: { input: 0.11, output: 0.55 } },
];
