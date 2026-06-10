import type { TiktokClient } from './client';
import type { FulfillmentResult } from '../shared/fulfillment';
import { getTiktokOrderDetails } from './order-detail';

const TIKTOK_SHIP_PACKAGE_PATH = '/fulfillment/202309/packages/ship';

interface TiktokFulfillmentResponse {
  code?: number;
  message?: string;
  data?: unknown;
}

/** Batch ship body per [Ship Package API](https://partner.tiktokshop.com/docv2/page/ship-package-202309): each entry must include `id` (package id). */
function buildShipPackagesBody(packageIds: string[]): Record<string, unknown> {
  const unique = Array.from(new Set(packageIds.map((p) => p.trim()).filter(Boolean)));
  return {
    packages: unique.map((id) => ({
      id,
      /** Seller drop-off; platform logistics may require `PICKUP` + `pickup_slot` per docs. */
      handover_method: 'DROP_OFF',
    })),
  };
}

type ResolvePackageIdsResult =
  | { ok: true; packageIds: string[] }
  | { ok: false; message: string };

/**
 * Resolve package IDs to ship: if `id` is an order id, use order detail `packageIds`;
 * otherwise treat `id` as a package id.
 *
 * If TikTok recognizes `id` as an order but returns no package ids yet, we must **not**
 * pass the order id to Ship Package (that yields `98001004` / No Valid FulfillUnit).
 */
export async function resolveTiktokPackageIdsToShip(
  client: TiktokClient,
  id: string,
  shopCipher: string,
): Promise<ResolvePackageIdsResult> {
  const trimmed = id.trim();
  if (!trimmed) return { ok: false, message: 'Empty order/package id.' };

  const detailMap = await getTiktokOrderDetails(client, [trimmed], shopCipher, true);
  const detail = detailMap.get(trimmed);
  if (detail) {
    const fromOrder = detail.packageIds?.filter(Boolean) ?? [];
    if (fromOrder.length > 0) return { ok: true, packageIds: fromOrder };

    const raw = detail.raw as { order_status?: string } | undefined;
    const st = raw?.order_status ?? '(unknown)';
    return {
      ok: false,
      message: [
        `Order ${trimmed} has no package id in TikTok order detail yet (API status: ${st}).`,
        'Ship Package requires a package FulfillUnit — create/split packages in Seller Center or via TikTok fulfillment APIs first, then pass the package id or retry when get-order-details returns packageIds.',
      ].join(' '),
    };
  }

  return { ok: true, packageIds: [trimmed] };
}

/**
 * Confirm/ship TikTok package(s).
 *
 * Accepts either a **package id** or an **order id** (resolves packages via order detail).
 * Uses POST body `{ packages: [{ id, handover_method }] }` ([Ship Package 202309](https://partner.tiktokshop.com/docv2/page/ship-package-202309)).
 */
export async function confirmTiktokFulfillment(
  client: TiktokClient,
  id: string,
  shopCipher: string,
): Promise<FulfillmentResult> {
  const trimmed = id.trim();
  if (!trimmed) {
    return {
      id,
      platform: 'tiktok',
      success: false,
      message: 'Empty order/package id.',
    };
  }

  try {
    const resolved = await resolveTiktokPackageIdsToShip(client, trimmed, shopCipher);
    if (!resolved.ok) {
      return { id: trimmed, platform: 'tiktok', success: false, message: resolved.message };
    }
    const packageIds = resolved.packageIds;
    if (packageIds.length === 0) {
      return {
        id: trimmed,
        platform: 'tiktok',
        success: false,
        message:
          'No package ids found. Use an order id that has packages, or pass the TikTok package id from search-orders `packageIds`.',
      };
    }

    const res = await client.post<TiktokFulfillmentResponse>(TIKTOK_SHIP_PACKAGE_PATH, {
      shopCipher,
      body: buildShipPackagesBody(packageIds),
    });
    return {
      id: trimmed,
      platform: 'tiktok',
      success: true,
      message:
        packageIds.length > 1
          ? `TikTok fulfillment confirmation sent for ${packageIds.length} packages.`
          : 'TikTok fulfillment confirmation sent.',
      raw: res,
    };
  } catch (err) {
    return {
      id: trimmed,
      platform: 'tiktok',
      success: false,
      message: (err as Error).message,
    };
  }
}
