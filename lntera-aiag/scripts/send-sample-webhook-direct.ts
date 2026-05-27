/**
 * Direct active-mode notification (no HTTP signature). Used by send-sample-webhook.mjs --direct.
 *
 * Starts the Discord bot in-process, invokes notifyTenantOfMarketplaceEvent, then exits.
 * Requires the same .env as Mastra (Supabase, GROQ, DISCORD_BOT_TOKEN, etc.).
 */
import { notifyTenantOfMarketplaceEvent } from '../src/mastra/active-mode/notifier';
import { startDiscordBots } from '../src/mastra/integrations/discord/bot';
import type { EventCategory } from '../src/mastra/integrations/shared/webhook-event-classifier';
import type { Platform } from '../src/mastra/integrations/shared/types';

const DEFAULT_TENANT = 'bc25b4f0-769b-4ac6-88c5-44287741cc75';

function parseArgs() {
  const args = process.argv.slice(2);
  let tenantId = DEFAULT_TENANT;
  let platform: Platform = 'shopee';
  let category: EventCategory = 'orders';

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--tenant' && args[i + 1]) {
      tenantId = args[++i];
    } else if (a === '--platform' && args[i + 1]) {
      const p = args[++i];
      if (p === 'shopee' || p === 'tiktok') platform = p;
    } else if (a === '--category' && args[i + 1]) {
      const c = args[++i];
      if (c === 'orders' || c === 'fulfillment' || c === 'returns') category = c;
    }
  }
  return { tenantId, platform, category };
}

function buildPayload(platform: Platform, category: EventCategory, shopId: string): unknown {
  const orderSn = `SAMPLE-${Date.now()}`;
  if (platform === 'shopee') {
    const codeByCategory: Record<EventCategory, number> = {
      orders: 3,
      fulfillment: 4,
      returns: 10,
      other: 99,
    };
    const statusByCategory: Record<EventCategory, string> = {
      orders: 'READY_TO_SHIP',
      fulfillment: 'SHIPPED',
      returns: 'RETURN_REQUESTED',
      other: 'UNKNOWN',
    };
    return {
      shop_id: Number(shopId) || shopId,
      code: codeByCategory[category],
      timestamp: Math.floor(Date.now() / 1000),
      data: {
        ordersn: orderSn,
        order_status: statusByCategory[category],
        update_time: Math.floor(Date.now() / 1000),
      },
    };
  }

  const typeByCategory: Record<EventCategory, number> = {
    orders: 1,
    fulfillment: 4,
    returns: 2,
    other: 99,
  };
  return {
    type: typeByCategory[category],
    shop_id: shopId,
    timestamp: Date.now(),
    data: {
      shop_id: shopId,
      order_id: orderSn,
      order_status: category === 'orders' ? 'AWAITING_SHIPMENT' : category === 'fulfillment' ? 'IN_TRANSIT' : 'RETURN_REQUESTED',
    },
  };
}

function codeFor(platform: Platform, category: EventCategory): string {
  if (platform === 'shopee') {
    const m: Record<EventCategory, string> = { orders: 'code:3', fulfillment: 'code:4', returns: 'code:10', other: 'code:99' };
    return m[category];
  }
  const m: Record<EventCategory, string> = { orders: 'type:1', fulfillment: 'type:4', returns: 'type:2', other: 'type:99' };
  return m[category];
}

async function main() {
  const { tenantId, platform, category } = parseArgs();
  const shopId = process.env.SAMPLE_WEBHOOK_SHOP_ID?.trim() || '0';

  console.info(`[sample-webhook:direct] tenant=${tenantId} platform=${platform} category=${category}`);

  const handle = await startDiscordBots();
  // Brief pause so ClientReady fires before outbound fetch.
  await new Promise((r) => setTimeout(r, 2500));

  const payload = buildPayload(platform, category, shopId);
  const result = await notifyTenantOfMarketplaceEvent({
    tenantId,
    platform,
    category,
    code: codeFor(platform, category),
    payload,
  });

  console.info(JSON.stringify({ mode: 'direct', result, payload }, null, 2));

  await handle.shutdown();
  process.exit(result.status === 'delivered' ? 0 : 1);
}

main().catch((err) => {
  console.error('[sample-webhook:direct] failed', err);
  process.exit(1);
});
