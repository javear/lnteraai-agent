import {
  buildAvailableGroqChain,
  type GroqModelChainEntry,
} from '../../models/groq-model-chain';
import {
  buildPortkeyModelConfig,
  type PortkeyMastraModelConfig,
} from './model-config';

export type PortkeyGroqModelChainEntry = {
  model: PortkeyMastraModelConfig;
  maxRetries: number;
};

export function buildAvailablePortkeyGroqChain(args: {
  providerSlug: string;
  tenantId: string | null | undefined;
  pinned?: string;
  largeContext?: boolean;
  chainOrder?: readonly string[];
  metadata?: Record<string, unknown>;
}): PortkeyGroqModelChainEntry[] {
  const groqChain = buildAvailableGroqChain({
    tenantId: args.tenantId,
    pinned: args.pinned,
    largeContext: args.largeContext,
    chainOrder: args.chainOrder,
  });

  return mapGroqChainToPortkey(groqChain, args.providerSlug, args.metadata);
}

export function mapGroqChainToPortkey(
  groqChain: GroqModelChainEntry[],
  providerSlug: string,
  metadata?: Record<string, unknown>,
): PortkeyGroqModelChainEntry[] {
  return groqChain.map((entry) => ({
    maxRetries: entry.maxRetries,
    model: buildPortkeyModelConfig({
      providerSlug,
      groqModelId: entry.model,
      metadata,
    }),
  }));
}

export function mapGroqModelIdsToPortkey(
  _groqModelIds: readonly string[],
  _providerSlug: string,
  _metadata?: Record<string, unknown>,
): string[] {
  return [..._groqModelIds];
}

/** Compare groq chain order before/after Portkey mapping (for verification scripts). */
export function groqChainOrderFromPortkeyChain(
  portkeyChain: PortkeyGroqModelChainEntry[],
): string[] {
  return portkeyChain.map((entry) => {
    const id = entry.model.id;
    const match = /^openai\/@[^/@]+\/(.+)$/i.exec(id);
    if (match) {
      const seg = match[1];
      return seg.startsWith('groq/') ? seg : `groq/${seg}`;
    }
    const legacy = /^openai\/@[^@]+@(.+)$/i.exec(id);
    if (legacy) {
      const seg = legacy[1];
      return seg.startsWith('groq/') ? seg : `groq/${seg}`;
    }
    return id;
  });
}
