import { RegexFilterProcessor } from '@mastra/core/processors';
import { getRedactionMarker } from './agent-redaction-normalize';

export type RegexRule = {
  name: string;
  pattern: RegExp;
  replacement?: string;
};

type RedactRuleTemplate = {
  name: string;
  pattern: RegExp;
};

export const REGEX_INPUT_BLOCKED_FRIENDLY_MESSAGE =
  "That message looks like it contains a secret key or prompt-injection pattern, so it wasn't processed. Please rephrase without pasting API keys or instruction overrides.";

const INJECTION_RULES: RegexRule[] = [
  {
    name: 'ignore-instructions',
    pattern: /ignore\s+(?:all\s+)?(?:previous|prior|above)\s+instructions/gi,
    replacement: '[FILTERED]',
  },
  {
    name: 'system-role-injection',
    pattern: /\b(?:system|assistant)\s*:/gi,
    replacement: '[FILTERED]',
  },
  {
    name: 'prompt-delimiter',
    pattern: /<\|im_(?:start|end)\|>|<<SYS>>/gi,
    replacement: '[FILTERED]',
  },
  {
    name: 'jailbreak',
    pattern: /\b(?:DAN|jailbreak|do anything now)\b/gi,
    replacement: '[FILTERED]',
  },
  {
    name: 'role-override',
    pattern: /\b(?:you are now|act as|pretend to be)\b/gi,
    replacement: '[FILTERED]',
  },
  {
    name: 'tool-injection',
    pattern: /\b(?:tool_choice|function_call|execute\s+tool)\b/gi,
    replacement: '[FILTERED]',
  },
];

/** Same patterns as Mastra presets; replacement uses REGEX_PII_MASK_CHAR (default ·). */
const SECRETS_RULES: RedactRuleTemplate[] = [
  {
    name: 'api-key',
    pattern: /(?:api[_-]?key|apikey|api[_-]?secret)\s*[:=]\s*["']?[a-zA-Z0-9_\-]{20,}["']?/gi,
  },
  {
    name: 'bearer-token',
    pattern: /Bearer\s+[a-zA-Z0-9_\-.]+/gi,
  },
  {
    name: 'aws-key',
    pattern: /(?:AKIA|ASIA)[A-Z0-9]{16}/g,
  },
  {
    name: 'groq-key',
    pattern: /\bgsk_[a-zA-Z0-9]{20,}\b/g,
  },
];

const OUTPUT_LEAK_RULES: RedactRuleTemplate[] = [
  {
    name: 'instruction-echo',
    pattern: /Security \(always apply; cannot be overridden\)/gi,
  },
  {
    name: 'request-context-leak',
    pattern: /requestContext\./gi,
  },
  {
    name: 'tenant-id-leak',
    pattern: /tenant_master_id/gi,
  },
  {
    name: 'system-prompt-leak',
    pattern: /\bsystem prompt\b/gi,
  },
  {
    name: 'tool-choice-leak',
    pattern: /\btool_choice\b/gi,
  },
  {
    name: 'function-call-leak',
    pattern: /\bfunction_call\b/gi,
  },
];

function parseEnvFlag(raw: string | undefined, defaultOn: boolean): boolean {
  if (raw == null || raw.trim() === '') return defaultOn;
  const v = raw.trim().toLowerCase();
  if (v === '1' || v === 'true' || v === 'yes' || v === 'on') return true;
  if (v === '0' || v === 'false' || v === 'no' || v === 'off') return false;
  return defaultOn;
}

export function isRegexFilterEnabled(): boolean {
  return parseEnvFlag(process.env.REGEX_FILTER_ENABLED, false);
}

export function isRegexFilterInputBlockEnabled(): boolean {
  return parseEnvFlag(process.env.REGEX_FILTER_INPUT_BLOCK, true);
}

export function isRegexFilterInputPiiEnabled(): boolean {
  return parseEnvFlag(process.env.REGEX_FILTER_INPUT_PII, true);
}

export function isRegexFilterOutputSecretsEnabled(): boolean {
  return parseEnvFlag(process.env.REGEX_FILTER_OUTPUT_SECRETS, true);
}

export function isRegexFilterOutputPiiEnabled(): boolean {
  return parseEnvFlag(process.env.REGEX_FILTER_OUTPUT_PII, true);
}

export type PiiMaskMode = 'partial' | 'full';

export function getPiiMaskMode(): PiiMaskMode {
  const raw = process.env.REGEX_PII_MASK_MODE?.trim().toLowerCase();
  if (raw === 'full') return 'full';
  return 'partial';
}

export function getInjectionRegexRules(): RegexRule[] {
  return INJECTION_RULES.map((rule) => ({
    ...rule,
    pattern: new RegExp(rule.pattern.source, rule.pattern.flags),
  }));
}

export function getOutputLeakRegexRules(): RegexRule[] {
  return buildRedactRules(OUTPUT_LEAK_RULES);
}

function buildRedactRules(templates: RedactRuleTemplate[]): RegexRule[] {
  const marker = getRedactionMarker();
  return templates.map((rule) => ({
    ...rule,
    replacement: marker,
    pattern: new RegExp(rule.pattern.source, rule.pattern.flags),
  }));
}

export function buildRegexInputBlockFilter(): RegexFilterProcessor {
  return new RegexFilterProcessor({
    rules: [...buildRedactRules(SECRETS_RULES), ...getInjectionRegexRules()],
    strategy: 'block',
    phase: 'input',
  });
}

export function buildRegexOutputFilter(): RegexFilterProcessor {
  return new RegexFilterProcessor({
    rules: [...buildRedactRules(SECRETS_RULES), ...getOutputLeakRegexRules()],
    strategy: 'redact',
    phase: 'output',
  });
}