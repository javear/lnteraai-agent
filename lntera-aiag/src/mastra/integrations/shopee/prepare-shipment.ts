import type { ShopeeClient } from './client';
import type { PrepareShipmentResult } from '../shared/fulfillment';
import { getShopeeOrderDetails } from './orders';
import { previewShopeeHandover } from './fulfillment';

/**
 * Shopee has no TikTok-style “create package” Open API in our flow; packages ship via `ship_order`.
 * This helper loads order detail and returns any existing `package_number` values for agent UX.
 */
export async function prepareShopeeShipmentContext(
  client: ShopeeClient,
  orderSn: string,
): Promise<PrepareShipmentResult> {
  const trimmed = orderSn.trim();
  if (!trimmed) {
    return { id: orderSn, platform: 'shopee', success: false, message: 'Empty order id.' };
  }

  try {
    const detailMap = await getShopeeOrderDetails(client, [trimmed], false);
    const detail = detailMap.get(trimmed);
    if (!detail) {
      return {
        id: trimmed,
        platform: 'shopee',
        success: false,
        message: `Order ${trimmed} not found for this Shopee shop (check shopId).`,
      };
    }

    const packageIds = detail.packageIds?.filter(Boolean) ?? [];
    let handover: Awaited<ReturnType<typeof previewShopeeHandover>> | null = null;
    try {
      handover = await previewShopeeHandover(client, trimmed);
    } catch {
      // get_shipping_parameter can fail if order not ready — still return package ids
    }

    const suffix =
      packageIds.length > 0
        ? ` Existing package_number(s): ${packageIds.join(', ')}.`
        : ' No package_number on detail yet (normal for some statuses).';

    const hoHint = handover?.needs_handover_choice
      ? ' **Next:** call confirm-order-fulfillment with `shopeeHandover: "pickup"` or `"dropoff"` (standard logistics).'
      : handover?.instant_suspected
        ? ' **Instant channel:** usually call confirm-order-fulfillment without `shopeeHandover` when only pickup is available (maps to Seller Centre processing / label).'
        : '';

    return {
      id: trimmed,
      platform: 'shopee',
      success: true,
      message: `Shopee prepare step (like TikTok create-package discovery): use **create-fulfillment-package** to read handover, then **confirm-order-fulfillment** (logistics.ship_order).${suffix}${hoHint}`,
      packageIds: packageIds.length > 0 ? packageIds : undefined,
      details: handover
        ? {
            handover,
            flow_alignment:
              'TikTok: create-fulfillment-package → packages → confirm-order-fulfillment. Shopee: this preview → confirm-order-fulfillment (pickup/dropoff choice when needed) → get-shipping-labels.',
          }
        : undefined,
    };
  } catch (err) {
    return {
      id: trimmed,
      platform: 'shopee',
      success: false,
      message: (err as Error).message,
    };
  }
}
