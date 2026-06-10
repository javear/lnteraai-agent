import { PinoLogger, type PinoLoggerOptions } from '@mastra/loggers';
import { compactArgs } from './compact-error';

/**
 * Pino logger that logs `err` / `error` fields as `{ type, message }` only.
 * Use for Mastra so Groq rate limits and API errors stay readable in the terminal.
 */
export class CompactPinoLogger extends PinoLogger {
  constructor(options?: PinoLoggerOptions) {
    super(options);
  }

  override debug(message: string, args: Record<string, unknown> = {}): void {
    super.debug(message, compactArgs(args));
  }

  override info(message: string, args: Record<string, unknown> = {}): void {
    super.info(message, compactArgs(args));
  }

  override warn(message: string, args: Record<string, unknown> = {}): void {
    super.warn(message, compactArgs(args));
  }

  override error(message: string, args: Record<string, unknown> = {}): void {
    super.error(message, compactArgs(args));
  }
}
