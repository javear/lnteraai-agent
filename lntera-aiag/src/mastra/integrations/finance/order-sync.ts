// Phase 2a: marketplace order → sale transaction. On an order webhook, fetch the order detail and — only
// when it's normalized to `completed` (the recognition trigger) — record an idempotent `sale` transaction
// (external_id = order id) with per-item lines, then post it to the ledger if accounting is enabled.
// PRICE/inventory are handled elsewhere; this is purely the financial record.
import type { MarketplaceConnection } from '../shared/types';
import type { NormalizedOrderDetail } from '../shared/orders';
import { logErrorBrief } from '../../logger/compact-error';
import { getShopeeClient } from '../shopee/client';
import { getShopeeOrderDetails } from '../shopee/orders';
import { getTiktokClient } from '../tiktok/client';
import { resolveTiktokOrderDetailsByShop } from '../tiktok/order-detail';
import { recordTransaction, type TransactionLineInput } from './transactions-repo';
import { maybePostTransaction } from './posting-engine';

function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
}

/** Extract the order id from a Shopee/TikTok order webhook payload. */
export function extractOrderId(platform: string, payload: unknown): string | null {
  const obj = asRecord(payload);
  const data = asRecord(obj.data ?? obj);
  const candidates =
    platform === 'tiktok'
      ? [data.order_id, data.orderId, obj.order_id]
      : [data.ordersn, data.order_sn, obj.ordersn, data.orderId];
  for (const c of candidates) {
    if (c != null && String(c).trim()) return String(c).trim();
  }
  return null;
}

function tiktokCiphers(connection: MarketplaceConnection): string[] {
  const out: string[] = [];
  if (connection.shop_cipher) out.push(connection.shop_cipher);
  const meta = (connection.raw_metadata ?? {}) as Record<string, unknown>;
  const shops = (meta.tiktok_shops ?? meta.shops) as unknown;
  if (Array.isArray(shops)) {
    for (const s of shops) {
      const c = (s as Record<string, unknown>)?.cipher;
      if (typeof c === 'string' && c.trim()) out.push(c.trim());
    }
  }
  return Array.from(new Set(out));
}

async function fetchOrderDetail(connection: MarketplaceConnection, orderId: string): Promise<NormalizedOrderDetail | null> {
  if (connection.platform === 'shopee') {
    const client = await getShopeeClient(connection.external_shop_id);
    const map = await getShopeeOrderDetails(client, [orderId], true);
    return map.get(orderId) ?? null;
  }
  if (connection.platform === 'tiktok') {
    const client = await getTiktokClient(connection.external_shop_id);
    const ciphers = tiktokCiphers(connection);
    if (ciphers.length === 0) return null;
    const map = await resolveTiktokOrderDetailsByShop(client, [orderId], true, { shopCiphers: ciphers });
    return map.get(orderId) ?? null;
  }
  return null;
}

/**
 * Record a `sale` for a marketplace order once it's completed. Idempotent by (tenant, marketplace, order
 * id) — re-deliveries / repeated webhooks update the same row. Fire-and-forget from the webhook; never
 * throws. Fees/refunds/payouts come from the settlement feed (Phase 2b), not here.
 */
export async function reconcileOrderTransaction(args: {
  tenantId: string;
  connection: MarketplaceConnection;
  orderId: string;
}): Promise<void> {
  try {
    const detail = await fetchOrderDetail(args.connection, args.orderId);
    if (!detail) return;
    if (detail.status !== 'completed') return; // recognition trigger: only on completed

    const lines: TransactionLineInput[] = (detail.items ?? []).map((it) => ({
      lineKind: 'product',
      description: it.name ?? it.sku ?? null,
      itemRefType: it.sku ? 'marketplace_sku' : null,
      externalLineId: it.id ?? null,
      quantity: it.quantity ?? null,
      unitPrice: it.price ?? null,
      amount: (it.price ?? 0) * (it.quantity ?? 1),
    }));

    const result = await recordTransaction({
      tenantId: args.tenantId,
      source: 'marketplace',
      marketplaceConnectionId: args.connection.id,
      platform: args.connection.platform,
      externalId: args.orderId,
      type: 'sale',
      status: 'completed',
      currency: detail.currency,
      grossAmount: detail.totalAmount, // marketplace order total is the authoritative gross
      occurredAt: detail.updatedAt ?? detail.createdAt,
      counterparty: detail.buyerName ? { name: detail.buyerName } : null,
      description: `${args.connection.platform === 'tiktok' ? 'TikTok' : 'Shopee'} order ${args.orderId}`,
      rawPayload: detail.raw ?? null,
      lines,
    });
    await maybePostTransaction(args.tenantId, result.id);
  } catch (err) {
    logErrorBrief(`[order-sync] reconcile failed (order=${args.orderId})`, err);
  }
}
