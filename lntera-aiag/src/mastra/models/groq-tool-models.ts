/** Tool-capable Groq chat models — see https://mastra.ai/models/providers/groq */
export const GROQ_TOOL_MODELS = [
  'groq/meta-llama/llama-4-scout-17b-16e-instruct',
  'groq/llama-3.3-70b-versatile',
  'groq/llama-3.1-8b-instant',
  'groq/openai/gpt-oss-120b',
  'groq/openai/gpt-oss-20b',
  'groq/qwen/qwen3-32b',
] as const;

export type GroqToolModelId = (typeof GROQ_TOOL_MODELS)[number];

export function isGroqToolModelId(value: string): value is GroqToolModelId {
  return (GROQ_TOOL_MODELS as readonly string[]).includes(value);
}
