import { z } from 'zod';

/**
 * Discord-friendly reply schema. The agent emits an object matching `discordReplySchema`,
 * and the dispatcher executes each op against `discord.js`.
 *
 * Add new op types by appending to the union here AND adding a case in
 * `discord/dispatcher.ts`. Keep field names stable; downstream tools may depend on them.
 */

/** Discord text channel send / reply (markdown allowed; long content is split downstream). */
export const discordTextOpSchema = z
  .object({
    message_type: z.literal('text'),
    /** Plain text or markdown. Split at 2000 chars by the dispatcher. */
    content: z.string().min(1),
    /** When set, posts as a reply to that message id; otherwise plain channel send. */
    to_message_id: z.string().min(1).optional(),
  })
  .strict();

/** Emoji reaction. `content` is the unicode emoji or `name:id` for custom emojis. */
export const discordReactionOpSchema = z
  .object({
    message_type: z.literal('reaction'),
    content: z.string().min(1),
    to_message_id: z.string().min(1),
  })
  .strict();

/** Send an image. `content` is the source URL; Discord uploads from URL. */
export const discordImageOpSchema = z
  .object({
    message_type: z.literal('image'),
    content: z.string().url(),
    caption: z.string().optional(),
    to_message_id: z.string().min(1).optional(),
  })
  .strict();

/** Generic file attachment. */
export const discordFileOpSchema = z
  .object({
    message_type: z.literal('file'),
    content: z.string().url(),
    name: z.string().optional(),
    caption: z.string().optional(),
    to_message_id: z.string().min(1).optional(),
  })
  .strict();

const discordEmbedFieldSchema = z
  .object({
    name: z.string().min(1).max(256),
    value: z.string().min(1).max(1024),
    inline: z.boolean().optional(),
  })
  .strict();

/** Rich embed (great for orders / products). Mirrors discord.js EmbedBuilder fields. */
export const discordEmbedOpSchema = z
  .object({
    message_type: z.literal('embed'),
    title: z.string().min(1).max(256).optional(),
    description: z.string().min(1).max(4000).optional(),
    url: z.string().url().optional(),
    /** Integer color (0xRRGGBB) or null/undefined for default. */
    color: z.number().int().min(0).max(0xffffff).optional(),
    fields: z.array(discordEmbedFieldSchema).max(25).optional(),
    footer: z.string().max(2048).optional(),
    to_message_id: z.string().min(1).optional(),
  })
  .strict();

/** Show "typing…" indicator for the given duration before the next op. */
export const discordTypingOpSchema = z
  .object({
    message_type: z.literal('typing'),
    duration_ms: z.number().int().min(0).max(15_000).optional(),
  })
  .strict();

/** Explicit "no reply" sentinel — used when the agent intentionally stays silent. */
export const discordNoopOpSchema = z
  .object({
    message_type: z.literal('noop'),
    /** Optional human-readable note (logged, never sent). */
    reason: z.string().optional(),
  })
  .strict();

export const discordReplyOpSchema = z.discriminatedUnion('message_type', [
  discordTextOpSchema,
  discordReactionOpSchema,
  discordImageOpSchema,
  discordFileOpSchema,
  discordEmbedOpSchema,
  discordTypingOpSchema,
  discordNoopOpSchema,
]);

export type DiscordReplyOp = z.infer<typeof discordReplyOpSchema>;

export const discordReplySchema = z
  .object({
    ops: z.array(discordReplyOpSchema).min(1).max(10),
  })
  .strict();

export type DiscordReply = z.infer<typeof discordReplySchema>;
