import type { MastraDBMessage } from '@mastra/core/agent';
import { TripWire } from '@mastra/core/agent';
import type {
  InputProcessor,
  OutputProcessor,
  ProcessInputArgs,
  ProcessOutputResultArgs,
  ProcessOutputStreamArgs,
} from '@mastra/core/processors';
import {
  buildRegexInputBlockFilter,
  buildRegexOutputFilter,
  getPiiMaskMode,
  isRegexFilterEnabled,
  isRegexFilterInputBlockEnabled,
  isRegexFilterInputPiiEnabled,
  isRegexFilterOutputPiiEnabled,
  isRegexFilterOutputSecretsEnabled,
  REGEX_INPUT_BLOCKED_FRIENDLY_MESSAGE,
} from '../agents/agent-regex-filter-config';
import {
  normalizeRedactionInMessages,
  normalizeRedactionStreamPart,
} from '../agents/agent-redaction-normalize';
import { applyPiiMask, applyPiiMaskToMessage } from '../agents/partial-pii-mask';

function findLatestUserMessage(messages: MastraDBMessage[]): MastraDBMessage | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg?.role === 'user') return msg;
  }
  return null;
}

function minimalProcessInputArgs(messages: MastraDBMessage[]): ProcessInputArgs {
  return {
    messages,
    messageList: { get: { all: { db: () => messages } } },
    abort: (reason?: string) => {
      throw new TripWire(reason ?? 'aborted');
    },
    systemMessages: [],
    state: {},
    retryCount: 0,
  } as unknown as ProcessInputArgs;
}

function runInputBlockFilter(message: MastraDBMessage): void {
  const filter = buildRegexInputBlockFilter();
  filter.processInput(minimalProcessInputArgs([message]));
}

function applyOutputPiiMaskToMessages(messages: MastraDBMessage[]): MastraDBMessage[] {
  const mode = getPiiMaskMode();
  for (const message of messages) {
    if (message.role !== 'assistant') continue;
    applyPiiMaskToMessage(message, mode);
  }
  return messages;
}

function applyOutputPiiMaskToStreamPart(args: ProcessOutputStreamArgs) {
  const part = args.part;
  if (!part || part.type !== 'text-delta') return part;
  const payload = part.payload;
  if (!payload || typeof payload.text !== 'string') return part;
  return {
    ...part,
    payload: {
      ...payload,
      text: applyPiiMask(payload.text, getPiiMaskMode()),
    },
  };
}

export function createRegexInputGuardProcessor(): InputProcessor {
  return {
    id: 'regex-input-guard',
    name: 'Regex input guard (secrets, injection, PII)',

    processInput({ messageList, abort }: ProcessInputArgs) {
      if (!isRegexFilterEnabled()) return messageList;

      const latestUser = findLatestUserMessage(messageList.get.all.db());
      if (!latestUser) return messageList;

      if (isRegexFilterInputBlockEnabled()) {
        try {
          runInputBlockFilter(latestUser);
        } catch (error) {
          if (error instanceof TripWire) {
            abort(REGEX_INPUT_BLOCKED_FRIENDLY_MESSAGE, {
              metadata: {
                code: 'regex_input_blocked',
                processorId: 'regex-filter',
                ...(error.options?.metadata && typeof error.options.metadata === 'object'
                  ? error.options.metadata
                  : {}),
              },
            });
          }
          throw error;
        }
      }

      if (isRegexFilterInputPiiEnabled()) {
        applyPiiMaskToMessage(latestUser, getPiiMaskMode());
      }

      return messageList;
    },
  };
}

export function createRegexOutputGuardProcessor(): OutputProcessor {
  const filter = buildRegexOutputFilter();

  return {
    id: 'regex-output-guard',
    name: 'Regex output guard (secrets, leaks, PII)',

    async processOutputStream(args: ProcessOutputStreamArgs) {
      if (!isRegexFilterEnabled()) return args.part;

      let part = args.part;
      if (isRegexFilterOutputSecretsEnabled()) {
        const filtered = await filter.processOutputStream(args);
        if (!filtered) return filtered;
        part = normalizeRedactionStreamPart(filtered);
      }

      if (isRegexFilterOutputPiiEnabled() && part) {
        return applyOutputPiiMaskToStreamPart({ ...args, part });
      }

      return part;
    },

    async processOutputResult(args: ProcessOutputResultArgs) {
      if (!isRegexFilterEnabled()) return args.messages;

      let messages = args.messages;
      if (isRegexFilterOutputSecretsEnabled()) {
        const filtered = filter.processOutputResult(args);
        messages = Array.isArray(filtered) ? filtered : args.messages;
        messages = normalizeRedactionInMessages(messages);
      }

      if (isRegexFilterOutputPiiEnabled()) {
        messages = applyOutputPiiMaskToMessages(messages);
      }

      return messages;
    },
  };
}
