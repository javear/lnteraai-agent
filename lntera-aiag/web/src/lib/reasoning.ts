// Strip a reasoning model's inline "thinking" (<think>…</think>, <reasoning>…</reasoning>, Kimi's
// ◁think▷…◁/think▷) out of streamed/final content so it never renders in the chat bubble. Mirrors the
// server util — most models emit reasoning as separate reasoning-delta chunks, but some inline it.
const PAIRED = [
  /<think>[\s\S]*?<\/think>/gi,
  /<reasoning>[\s\S]*?<\/reasoning>/gi,
  /◁think▷[\s\S]*?◁\/think▷/g,
];

/** Remove finished + leading-unclosed reasoning blocks. Safe to run on partial (streaming) text. */
export function stripReasoning(input: string): string {
  if (!input) return input;
  let s = input;
  for (const re of PAIRED) s = s.replace(re, '');
  // Leading open tag with no close yet (mid-stream or truncated) ⇒ it's all reasoning so far.
  s = s.replace(/^\s*<think>[\s\S]*$/i, '');
  s = s.replace(/^\s*<reasoning>[\s\S]*$/i, '');
  s = s.replace(/^\s*◁think▷[\s\S]*$/, '');
  return s;
}
