import type { TiktokClient } from './client';
import type { PrepareShipmentResult } from '../shared/fulfillment';
import { extractPackageIdsFromTiktokCreatePackagesData } from './create-package-parse';
import { getTiktokOrderDetails } from './order-detail';

/** POST /fulfillment/202309/packages — see TikTok Partner “Create Package” 202309. */
const TIKTOK_CREATE_PACKAGES_PATH = '/fulfillment/202309/packages';

interface TiktokCreatePackagesResponse {
  code?: number;
  message?: string;
  data?: unknown;
}

function buildCreatePackagesBody(orderId: string, orderLineItemIds: string[]): Record<string, unknown> {
  const body: Record<string, unknown> = { order_id: orderId };
  const uniqueLines = Array.from(new Set(orderLineItemIds.map((s) => s.trim()).filter(Boolean)));
  if (uniqueLines.length > 0) body.order_line_item_ids = uniqueLines;
  return body;
}

/**
 * Create fulfillment package(s) for a TikTok **order id**.
 * If the order already has packages in order detail, returns success and existing `packageIds` (no second create).
 */
export async function createTiktokFulfillmentPackages(
  client: TiktokClient,
  orderId: string,
  shopCipher: string,
): Promise<PrepareShipmentResult> {
  const trimmed = orderId.trim();
  if (!trimmed) {
    return { id: orderId, platform: 'tiktok', success: false, message: 'Empty order id.' };
  }

  try {
    const detailMap = await getTiktokOrderDetails(client, [trimmed], shopCipher, true);
    const detail = detailMap.get(trimmed);
    if (!detail) {
      return {
        id: trimmed,
        platform: 'tiktok',
        success: false,
        message: `Order ${trimmed} not found for this TikTok shop (check shopId / shop_cipher).`,
      };
    }

    const existing = detail.packageIds?.filter(Boolean) ?? [];
    if (existing.length > 0) {
      return {
        id: trimmed,
        platform: 'tiktok',
        success: true,
        message: `Order already has ${existing.length} package(s); create skipped.`,
        packageIds: existing,
      };
    }

    const lineIds = detail.orderLineItemIds?.filter(Boolean) ?? [];
    const res = await client.post<TiktokCreatePackagesResponse>(TIKTOK_CREATE_PACKAGES_PATH, {
      shopCipher,
      body: buildCreatePackagesBody(trimmed, lineIds),
    });

    const created = extractPackageIdsFromTiktokCreatePackagesData(res.data);
    const afterMap = await getTiktokOrderDetails(client, [trimmed], shopCipher, false);
    const after = afterMap.get(trimmed);
    const merged = [...new Set([...created, ...(after?.packageIds?.filter(Boolean) ?? [])])];

    return {
      id: trimmed,
      platform: 'tiktok',
      success: true,
      message:
        merged.length > 0
          ? `Created or resolved ${merged.length} package(s). Use confirm-order-fulfillment with package id(s) or order id.`
          : 'Create package request accepted; TikTok returned no package id in the response — call get-order-details to read packageIds.',
      packageIds: merged.length > 0 ? merged : undefined,
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
