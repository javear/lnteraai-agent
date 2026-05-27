import type { FulfillmentPlatform } from './fulfillment';

export interface ShippingLabelResult {
  id: string;
  platform: FulfillmentPlatform;
  success: boolean;
  message: string;
  details?: unknown;
  raw?: unknown;
  /** TikTok package ids or Shopee package_number values touched */
  packageRefs?: string[];
}

export interface ShippingLabelSummary {
  total: number;
  success: number;
  failed: number;
}

export function buildShippingLabelSummary(results: ShippingLabelResult[]): ShippingLabelSummary {
  const success = results.filter((r) => r.success).length;
  return {
    total: results.length,
    success,
    failed: results.length - success,
  };
}
