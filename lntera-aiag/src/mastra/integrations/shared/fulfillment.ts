import type { Platform } from './types';

export type FulfillmentPlatform = Extract<Platform, 'shopee' | 'tiktok'>;

export interface FulfillmentTarget {
  id: string;
  platform: FulfillmentPlatform;
  /**
   * `marketplace_connections.external_shop_id`, or TikTok **`shop_cipher`** from search when multi-shop
   * (same string as each order row’s `shopId`).
   */
  shopId?: string;
  /**
   * Shopee `ship_order` only: when standard logistics offers **both** pickup and drop-off (e.g. J&T),
   * pass **`pickup`** (jemput) or **`dropoff`** (antar ke counter). Instant / pickup-only channels omit this.
   */
  shopeeHandover?: 'pickup' | 'dropoff';
}

export interface FulfillmentResult {
  id: string;
  platform: FulfillmentPlatform;
  success: boolean;
  message: string;
  /** Marketplace-facing summary (normalized fields, human-readable dates). */
  details?: unknown;
  raw?: unknown;
}

/** Result of prepare/create-package step; adds marketplace package ids when known. */
export interface PrepareShipmentResult extends FulfillmentResult {
  packageIds?: string[];
}

export interface FulfillmentSummary {
  total: number;
  success: number;
  failed: number;
}

export interface FulfillmentResponse {
  results: FulfillmentResult[];
  summary: FulfillmentSummary;
}

export function buildFulfillmentSummary(results: FulfillmentResult[]): FulfillmentSummary {
  const success = results.filter((r) => r.success).length;
  return {
    total: results.length,
    success,
    failed: results.length - success,
  };
}

export function buildPrepareShipmentSummary(results: PrepareShipmentResult[]): FulfillmentSummary {
  return buildFulfillmentSummary(results);
}
