/**
 * Two-step confirmation for destructive tool actions.
 *
 * Pattern:
 *   1. The agent invokes a destructive tool without `confirm: true`.
 *   2. The tool computes a `preview` (the exact effect it would have) and
 *      throws `ToolConfirmationRequired`. `createTool`'s error path forwards
 *      the JSON-serializable payload to the LLM, which then shows the preview
 *      to the user.
 *   3. The user explicitly acknowledges and the agent re-invokes the same tool
 *      with `confirm: true`.
 *
 * The error itself is plain (no stack trace pollution); its `payload` is what
 * the LLM sees and renders to the user.
 */

export interface ToolConfirmationPayload<TPreview = unknown> {
  requires_confirmation: true;
  /** Stable code so the agent can recognise this branch across tools. */
  reason: 'confirmation_required';
  /** Free-form, human-readable summary of the pending action. */
  message: string;
  /** Tool-specific structured preview (e.g. before/after diff, deletion target). */
  preview: TPreview;
  /** The tool the user must re-invoke with `confirm: true`. */
  tool_id?: string;
  /** Index signature so the payload satisfies `Record<string, unknown>` outputs. */
  [key: string]: unknown;
}

export class ToolConfirmationRequired<TPreview = unknown> extends Error {
  readonly payload: ToolConfirmationPayload<TPreview>;

  constructor(message: string, preview: TPreview, toolId?: string) {
    super(message);
    this.name = 'ToolConfirmationRequired';
    this.payload = {
      requires_confirmation: true,
      reason: 'confirmation_required',
      message,
      preview,
      ...(toolId ? { tool_id: toolId } : {}),
    };
  }
}

export function isToolConfirmationRequired(err: unknown): err is ToolConfirmationRequired {
  return err instanceof ToolConfirmationRequired;
}

interface AssertConfirmedOptions<TPreview> {
  /** Pass the boolean from the tool's input (`args.confirm`). */
  confirm: unknown;
  /** Tool-specific structured preview describing the exact effect. */
  preview: TPreview;
  /** Sentence the user will see; should describe the action and target. */
  message: string;
  /** Optional tool id (forwarded to the LLM so it knows which tool to re-call). */
  toolId?: string;
}

/**
 * Throws `ToolConfirmationRequired` when `confirm !== true`. The tool's
 * `execute` function should call this BEFORE issuing any irreversible API call.
 */
export function assertConfirmed<TPreview>(opts: AssertConfirmedOptions<TPreview>): void {
  if (opts.confirm === true) return;
  throw new ToolConfirmationRequired(opts.message, opts.preview, opts.toolId);
}

/**
 * Map an arbitrary error to a JSON-friendly payload for tools that catch
 * `ToolConfirmationRequired` themselves (instead of letting it bubble).
 * Returns `null` for unrelated errors.
 */
export function confirmationPayloadFromError(err: unknown): ToolConfirmationPayload | null {
  if (isToolConfirmationRequired(err)) return err.payload;
  return null;
}

/** Append to a tool `description` when it uses `assertConfirmed` / `ToolConfirmationRequired`. */
export const TOOL_TWO_STEP_CONFIRM_DESC =
  '**Two-step confirmation:** call without `confirm` (or `confirm: false`) first. If the result has `requires_confirmation: true`, show the user the returned `preview` and `message` and wait for explicit approval; then re-call this tool with `confirm: true` and the same other arguments. Never auto-confirm. If the user declines or wants changes, adjust inputs or use other tools instead of confirming.';
