import { getGeneralAgentMemoryOptions } from './agent-memory-config';

/** Memory options for generalAgent.generate / stream (thread + resource required at call site). */
export function buildGeneralAgentMemoryBinding(input: {
  thread: string;
  resource: string;
}): {
  thread: string;
  resource: string;
  options: ReturnType<typeof getGeneralAgentMemoryOptions>;
} {
  return {
    thread: input.thread,
    resource: input.resource,
    options: getGeneralAgentMemoryOptions(),
  };
}
