import {
  type ActiveLlmProvider,
  buildAvailableLlmChain,
} from '../../models/llm-model-chain';
import { buildPortkeyModelConfig, type PortkeyMastraModelConfig } from './model-config';

export type PortkeyLlmModelChainEntry = {
  model: PortkeyMastraModelConfig;
  maxRetries: number;
};

/**
 * Build the tenant's rolling model chain across ALL active providers, mapped to Portkey inline
 * model configs. Each entry routes to its own provider slug; metadata is attached per model.
 */
export function buildAvailablePortkeyLlmChain(args: {
  providers: ActiveLlmProvider[];
  tenantId: string | null | undefined;
  pinned?: string;
  largeContext?: boolean;
  chainOrder?: readonly string[];
  metadata?: Record<string, unknown>;
}): PortkeyLlmModelChainEntry[] {
  const chain = buildAvailableLlmChain({
    providers: args.providers,
    tenantId: args.tenantId,
    pinned: args.pinned,
    largeContext: args.largeContext,
    chainOrder: args.chainOrder,
  });

  return chain.map((entry) => ({
    maxRetries: entry.maxRetries,
    model: buildPortkeyModelConfig({
      providerSlug: entry.providerSlug,
      groqModelId: entry.model,
      metadata: args.metadata,
    }),
  }));
}
