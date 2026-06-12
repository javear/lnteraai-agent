// Deterministic (NO-LLM) product-sync notifications. Per-product prompts fire often, so they must
// never invoke the model — these are fixed templates with token-free action buttons (web) + a
// Discord deep-link (Discord has no button infra). Web delivery carries the actions/contextRef so the
// client renders buttons and POSTs the choice to /svc/v1/products/sync-actions (never the agent).
//
// INVARIANT: this file must not import generalAgent or any LLM client.
import { logErrorBrief } from '../logger/compact-error';
import { deliverTenantWebNotification, notificationsThreadId } from '../active-mode/web-delivery';
import type { NotificationAction, NotificationContextRef } from '../integrations/realtime/broadcast';
import {
  resolveDiscordChannelsForTenant,
  sendDiscordToTenant,
} from '../integrations/discord/outbound';
import type { DiscordReply } from '../integrations/discord/reply-schema';
import { webAppAbsoluteUrl } from '../server/web-app-origin';
import type { ProductSyncNotice } from '../integrations/products/ingest-marketplace-product';
import type { ResyncSummary } from './product-sync-engine';
import { markNotified, recentlyNotified } from './product-sync-dedup';

const BATCH_THRESHOLD = 5;

function displayPlatform(platform?: string | null): string {
  if (platform === 'tiktok') return 'TikTok Shop';
  if (platform === 'shopee') return 'Shopee';
  return platform || 'your marketplace';
}

interface RenderedNotice {
  text: string;
  heading: string;
  actions: NotificationAction[];
  contextRef: NotificationContextRef;
}

function renderNotice(notice: ProductSyncNotice): RenderedNotice {
  const platformName = displayPlatform(notice.platform);
  const name = notice.externalProductName || `product ${notice.externalProductId}`;
  const match = notice.matchTitle ?? '';
  const contextRef: NotificationContextRef = {
    linkId: notice.linkId,
    internalProductId: notice.internalProductId ?? undefined,
    platform: notice.platform,
    productId: notice.externalProductId,
  };

  switch (notice.kind) {
    case 'new_product':
      return {
        heading: `${platformName} · new product`,
        text: `🆕 "${name}" from ${platformName} isn't in your catalog yet. Add it?`,
        actions: [
          { id: 'create', label: 'Yes, add it', kind: 'sync_action', style: 'primary' },
          { id: 'create_always', label: 'Yes, and always', kind: 'sync_action' },
          { id: 'skip', label: 'No', kind: 'sync_action', style: 'default' },
        ],
        contextRef,
      };
    case 'suggest_map':
      return {
        heading: `${platformName} · possible match`,
        text: `🔗 "${name}" from ${platformName} looks like "${match}". Link them?`,
        actions: [
          { id: 'map', label: 'Yes, link', kind: 'sync_action', style: 'primary' },
          { id: 'map_always', label: 'Yes, auto-link strong matches', kind: 'sync_action' },
          { id: 'create', label: 'No, add as new', kind: 'sync_action' },
          { id: 'ignore', label: 'Ignore', kind: 'sync_action', style: 'default' },
        ],
        contextRef,
      };
    case 'low_match':
      return {
        heading: `${platformName} · uncertain match`,
        text: `❓ "${name}" from ${platformName} might match "${match}" (low confidence).`,
        actions: [
          { id: 'map', label: 'Link them', kind: 'sync_action', style: 'primary' },
          { id: 'create', label: 'Add as new', kind: 'sync_action' },
          { id: 'skip', label: 'Skip', kind: 'sync_action', style: 'default' },
        ],
        contextRef,
      };
    case 'auto_created_fyi':
      return {
        heading: `${platformName} · added`,
        text: `✅ Added "${name}" from ${platformName} to your catalog automatically.`,
        actions: [{ id: 'undo', label: 'Undo', kind: 'sync_action', style: 'default' }],
        contextRef,
      };
    case 'auto_mapped_fyi':
      return {
        heading: `${platformName} · linked`,
        text: `🔗 Linked "${name}" from ${platformName} to "${match}" automatically.`,
        actions: [{ id: 'undo', label: 'Undo', kind: 'sync_action', style: 'default' }],
        contextRef,
      };
  }
}

async function deliverDiscordDeepLink(tenantId: string, text: string): Promise<void> {
  try {
    const channels = await resolveDiscordChannelsForTenant(tenantId);
    if (channels.length === 0) return;
    const url = webAppAbsoluteUrl(`/c/${notificationsThreadId(tenantId)}`);
    const reply: DiscordReply = {
      ops: [{ message_type: 'text', content: `${text}\n👉 Decide here: ${url}` }],
    };
    await sendDiscordToTenant(tenantId, reply);
  } catch (err) {
    logErrorBrief(`[product-sync] discord deep-link failed tenant=${tenantId}`, err);
  }
}

async function deliverNotice(
  tenantId: string,
  notice: ProductSyncNotice,
  opts: { broadcast?: boolean; push?: boolean } = {},
): Promise<void> {
  const r = renderNotice(notice);
  await deliverTenantWebNotification({
    tenantId,
    text: r.text,
    heading: r.heading,
    kind: 'product_sync',
    deterministic: true,
    actions: r.actions,
    contextRef: r.contextRef,
    marketplace: { platform: notice.platform },
    broadcast: opts.broadcast,
    push: opts.push,
  });
  // Discord deep-link only on broadcasted (not coalesced persist-only) notices.
  if (opts.broadcast !== false) await deliverDiscordDeepLink(tenantId, r.text);
}

/** Single per-product prompt (webhook path). Guards against duplicate fires for the same link. */
export async function notifyProductSyncDecision(
  tenantId: string,
  notice: ProductSyncNotice | null,
): Promise<void> {
  if (!notice) return;
  if (recentlyNotified(notice.linkId)) return;
  markNotified(notice.linkId);
  await deliverNotice(tenantId, notice);
}

/** Batch summary (collapses a resync/webhook flood into one broadcast+push). */
export async function notifyBatchSummary(
  tenantId: string,
  count: number,
  platform?: string | null,
): Promise<void> {
  const platformName = platform ? displayPlatform(platform) : 'your marketplaces';
  const text = `📦 ${count} new product${count === 1 ? '' : 's'} from ${platformName} need your review.`;
  const threadPath = `/c/${notificationsThreadId(tenantId)}`;
  await deliverTenantWebNotification({
    tenantId,
    text,
    heading: 'Products to review',
    kind: 'product_sync',
    deterministic: true,
    actions: [
      { id: 'review', label: 'Review', kind: 'link', href: threadPath, style: 'primary' },
      { id: 'import_all', label: 'Import all', kind: 'resync', style: 'default' },
    ],
    contextRef: { platform: platform ?? undefined },
    marketplace: { platform: platform ?? undefined },
  });
  await deliverDiscordDeepLink(tenantId, text);
}

async function deliverAutoSummary(
  tenantId: string,
  autoCreated: number,
  autoMapped: number,
): Promise<void> {
  const bits: string[] = [];
  if (autoCreated) bits.push(`${autoCreated} added`);
  if (autoMapped) bits.push(`${autoMapped} auto-linked`);
  if (bits.length === 0) return;
  await deliverTenantWebNotification({
    tenantId,
    text: `✅ Sync complete: ${bits.join(' · ')}.`,
    heading: 'Sync complete',
    kind: 'product_sync',
    deterministic: true,
    marketplace: {},
  });
}

/**
 * Dispatch a resync run's notices. Prompts that need a decision are delivered individually when few,
 * or coalesced (persist each silently + ONE batch broadcast/push) when many. Auto create/link FYIs
 * are summarized when numerous.
 */
export async function dispatchResyncNotices(tenantId: string, summary: ResyncSummary): Promise<void> {
  const prompts = summary.notices.filter(
    (n) => n.kind === 'new_product' || n.kind === 'suggest_map' || n.kind === 'low_match',
  );
  const fyis = summary.notices.filter(
    (n) => n.kind === 'auto_created_fyi' || n.kind === 'auto_mapped_fyi',
  );

  if (prompts.length > BATCH_THRESHOLD) {
    for (const n of prompts) {
      markNotified(n.linkId);
      await deliverNotice(tenantId, n, { broadcast: false, push: false }); // persist-only
    }
    await notifyBatchSummary(tenantId, prompts.length, prompts[0]?.platform);
  } else {
    for (const n of prompts) {
      if (recentlyNotified(n.linkId)) continue;
      markNotified(n.linkId);
      await deliverNotice(tenantId, n);
    }
  }

  if (fyis.length > BATCH_THRESHOLD) {
    await deliverAutoSummary(tenantId, summary.autoCreated, summary.autoMapped);
  } else {
    for (const n of fyis) {
      markNotified(n.linkId);
      await deliverNotice(tenantId, n);
    }
  }
}

/**
 * Dispatch a resync's notices AND a terminal status line. Used by the REST/button path (no agent to
 * report the outcome). The agent tool uses dispatchResyncNotices directly (it reports its own summary).
 */
export async function notifyResyncOutcome(tenantId: string, summary: ResyncSummary): Promise<void> {
  await dispatchResyncNotices(tenantId, summary);
  if (summary.status === 'all_synced') {
    await deliverTenantWebNotification({
      tenantId,
      text: `✅ All ${summary.scanned} product${summary.scanned === 1 ? '' : 's'} are already synced.`,
      heading: 'Already synced',
      kind: 'product_sync',
      deterministic: true,
      marketplace: {},
    });
  } else if (summary.status === 'no_connection') {
    await deliverTenantWebNotification({
      tenantId,
      text: 'No connected marketplace to sync. Connect Shopee or TikTok Shop first.',
      heading: 'Nothing to sync',
      kind: 'product_sync',
      deterministic: true,
      marketplace: {},
    });
  }
}

/** Deterministic "store connected — import now?" offer (token-free actions). */
export async function notifyConnectedOfferSync(
  tenantId: string,
  platform: string,
  shopName?: string | null,
): Promise<void> {
  const platformName = displayPlatform(platform);
  const text = `✅ ${platformName}${shopName ? ` (${shopName})` : ''} connected. Import your products now?`;
  await deliverTenantWebNotification({
    tenantId,
    text,
    heading: `${platformName} connected`,
    kind: 'product_sync',
    deterministic: true,
    actions: [
      { id: 'sync_now', label: 'Yes, import now', kind: 'resync', style: 'primary' },
      { id: 'sync_auto', label: 'Yes, and keep in sync', kind: 'resync' },
      { id: 'not_now', label: 'Not now', kind: 'dismiss', style: 'default' },
    ],
    contextRef: { platform },
    marketplace: { platform },
  });
  await deliverDiscordDeepLink(tenantId, text);
}
