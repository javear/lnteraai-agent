// Strip a reasoning model's "thinking" out of user-facing text. Some models inline their chain-of-
// thought into the content as <think>…</think> (or <reasoning>…</reasoning>, or Kimi's ◁think▷…◁/think▷).
// That must never reach a notification, a scheduled-task result, or a persisted reply. Handles paired
// blocks anywhere, and an UNCLOSED leading block (the model opened a think block but the close got
// dropped/merged) by removing everything up to the first close — or, if there's no close at all, the
// whole leading think run.
const PAIRED = [
  /<think>[\s\S]*?<\/think>/gi,
  /<reasoning>[\s\S]*?<\/reasoning>/gi,
  /◁think▷[\s\S]*?◁\/think▷/g,
];

export function stripReasoning(input: string): string {
  if (!input) return input;
  let s = input;
  for (const re of PAIRED) s = s.replace(re, '');
  // A leading open tag with no matching close ⇒ the model never emitted real content (it's all thinking).
  s = s.replace(/^\s*<think>[\s\S]*$/i, '');
  s = s.replace(/^\s*<reasoning>[\s\S]*$/i, '');
  s = s.replace(/^\s*◁think▷[\s\S]*$/, '');
  // Defensive: any stray standalone tags left over.
  s = s.replace(/<\/?(think|reasoning)>/gi, '').replace(/◁\/?think▷/g, '');
  return s.trim();
}
