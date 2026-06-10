import type { ShopeeClient } from './client';
import type { FulfillmentResult } from '../shared/fulfillment';
import { getShopeeOrderDetails } from './orders';

const SHOPEE_GET_SHIPPING_PARAMETER_PATH = '/api/v2/logistics/get_shipping_parameter';
const SHOPEE_SHIP_ORDER_PATH = '/api/v2/logistics/ship_order';

interface ShopeeBaseResponse {
  error?: string;
  message?: string;
  request_id?: string;
}

interface ShopeeShippingParameterResponse extends ShopeeBaseResponse {
  response?: {
    info_needed?: {
      pickup?: string[];
      dropoff?: string[];
      non_integrated?: string[];
    };
    pickup?: {
      address_list?: Array<{
        address_id: number;
        region?: string;
        address?: string;
        zipcode?: string;
        address_flag?: string[];
        time_slot_list?: Array<{ date?: number; pickup_time_id?: string; flags?: string[] }>;
      }>;
    };
    dropoff?: {
      branch_list?: Array<{ branch_id: number }>;
      slug_list?: Array<{ slug?: string; slug_name?: string }>;
    };
  };
}

interface ShopeeShipOrderResponse extends ShopeeBaseResponse {
  warning?: string;
  response?: unknown;
}

/**
 * Some channels (instant / single OFG) return `logistics.order_not_exist` for get_shipping_parameter
 * when only `order_sn` is sent; passing the first `package_number` from order detail fixes it.
 * Split (multi-package) orders: always pass `splitFirstPackage` on the first attempt.
 */
async function fetchGetShippingParameter(
  client: ShopeeClient,
  orderSn: string,
  opts: {
    splitFirstPackage?: string;
    singlePackageFallback?: string;
  },
): Promise<{ sp: ShopeeShippingParameterResponse; package_number_queried?: string }> {
  const trimmed = orderSn.trim();
  type Attempt = { package_number?: string };
  const attempts: Attempt[] = opts.splitFirstPackage
    ? [{ package_number: opts.splitFirstPackage }]
    : opts.singlePackageFallback
      ? [{}, { package_number: opts.singlePackageFallback }]
      : [{}];

  let lastErr: Error | undefined;

  for (const a of attempts) {
    const q: Record<string, string> = { order_sn: trimmed };
    if (a.package_number) q.package_number = a.package_number;
    try {
      const sp = await client.get<ShopeeShippingParameterResponse>(
        SHOPEE_GET_SHIPPING_PARAMETER_PATH,
        q,
      );
      return { sp, package_number_queried: a.package_number };
    } catch (e) {
      const err = e instanceof Error ? e : new Error(String(e));
      lastErr = err;
      const isOrderNotExist = /order_not_exist/i.test(err.message);
      const mayRetry =
        !opts.splitFirstPackage &&
        isOrderNotExist &&
        !a.package_number &&
        Boolean(opts.singlePackageFallback);
      if (!mayRetry) throw err;
    }
  }
  throw lastErr ?? new Error('Shopee get_shipping_parameter failed');
}

const SHOPEE_REGION_TIMEZONE: Record<string, string> = {
  SG: 'Asia/Singapore',
  MY: 'Asia/Kuala_Lumpur',
  TH: 'Asia/Bangkok',
  PH: 'Asia/Manila',
  VN: 'Asia/Ho_Chi_Minh',
  ID: 'Asia/Jakarta',
  TW: 'Asia/Taipei',
  BR: 'America/Sao_Paulo',
  MX: 'America/Mexico_City',
  CL: 'America/Santiago',
  CO: 'America/Bogota',
  PL: 'Europe/Warsaw',
  ES: 'Europe/Madrid',
  FR: 'Europe/Paris',
  IN: 'Asia/Kolkata',
};

function shopeeRegionTimeZone(region: string | undefined): string {
  const key = (region ?? '').trim().toUpperCase();
  return SHOPEE_REGION_TIMEZONE[key] ?? 'UTC';
}

function pickupSlotEpochSeconds(slot: {
  date?: unknown;
  pickup_time_id?: unknown;
}): number | null {
  if (typeof slot.date === 'number' && Number.isFinite(slot.date)) return slot.date;
  const id = slot.pickup_time_id;
  if (typeof id === 'string' && /^\d+$/.test(id)) return Number(id);
  if (typeof id === 'number' && Number.isFinite(id)) return id;
  return null;
}

function formatPickupHuman(epochSec: number, timeZone: string) {
  const d = new Date(epochSec * 1000);
  const date_local_long = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  }).format(d);
  const datetime_local = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    weekday: 'short',
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZoneName: 'short',
  }).format(d);
  const date_local_iso = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(d);
  return { date_local_long, datetime_local, date_local_iso, time_zone: timeZone };
}

function normalizeShopeePickupTimeSlots(
  slots: unknown,
  timeZone: string,
): Array<Record<string, unknown>> {
  if (!Array.isArray(slots)) return [];
  const out: Array<Record<string, unknown>> = [];
  for (const s of slots) {
    if (!s || typeof s !== 'object') continue;
    const slot = s as {
      date?: unknown;
      pickup_time_id?: unknown;
      flags?: unknown;
    };
    const pickup_time_id =
      slot.pickup_time_id != null && String(slot.pickup_time_id).length > 0
        ? String(slot.pickup_time_id)
        : '';
    const epoch = pickupSlotEpochSeconds(slot);
    const base = {
      pickup_time_id,
      flags: Array.isArray(slot.flags) ? slot.flags : undefined,
    };
    if (epoch == null || !Number.isFinite(epoch)) {
      out.push({ ...base, date_unix: null, human: null });
      continue;
    }
    const human = formatPickupHuman(epoch, timeZone);
    out.push({
      ...base,
      date_unix: epoch,
      human: {
        date_long: human.date_local_long,
        datetime: human.datetime_local,
        calendar_date: human.date_local_iso,
        time_zone: human.time_zone,
      },
    });
  }
  return out;
}

/**
 * Compact, user-facing summary of Shopee get_shipping_parameter + ship_order (human pickup times).
 */
function buildShopeeFulfillmentDetails(
  orderSn: string,
  isSplitOrder: boolean,
  packageNumberUsed: string | undefined,
  sp: ShopeeShippingParameterResponse,
  shipRes: ShopeeShipOrderResponse,
  shipBody: Record<string, unknown>,
  flags: { retried_without_package_number?: boolean } = {},
): Record<string, unknown> {
  const resp = sp.response;
  const info = resp?.info_needed;
  const paths: Record<string, { required_fields: string[] }> = {};
  if (info?.pickup?.length) paths.pickup = { required_fields: [...info.pickup] };
  if (info?.dropoff?.length) paths.dropoff = { required_fields: [...info.dropoff] };
  if (info?.non_integrated?.length) {
    paths.non_integrated = { required_fields: [...info.non_integrated] };
  }

  const addressesRaw = resp?.pickup?.address_list ?? [];
  const pickup_options = addressesRaw.map((addr) => {
    const region = typeof addr.region === 'string' ? addr.region : undefined;
    const tz = shopeeRegionTimeZone(region);
    const line = typeof addr.address === 'string' ? addr.address : '';
    const zip = typeof addr.zipcode === 'string' ? addr.zipcode : '';
    const summary = [line, zip].filter(Boolean).join(', ');
    return {
      address_id: addr.address_id,
      region,
      address_summary: summary || undefined,
      flags: Array.isArray(addr.address_flag) ? addr.address_flag : undefined,
      time_slots: normalizeShopeePickupTimeSlots(addr.time_slot_list, tz),
    };
  });

  let submitted: Record<string, unknown> | undefined;
  if (shipBody.pickup && typeof shipBody.pickup === 'object') {
    const p = shipBody.pickup as Record<string, unknown>;
    const addressId = p.address_id;
    const ptid = p.pickup_time_id != null ? String(p.pickup_time_id) : '';
    const matchAddr = addressesRaw.find((x) => x.address_id === addressId);
    const tz = shopeeRegionTimeZone(
      typeof matchAddr?.region === 'string' ? matchAddr.region : undefined,
    );
    const slotSrc =
      matchAddr?.time_slot_list && ptid
        ? matchAddr.time_slot_list.find(
            (x) => String(x.pickup_time_id ?? '') === ptid,
          )
        : undefined;
    const epoch =
      slotSrc != null
        ? pickupSlotEpochSeconds(slotSrc)
        : ptid && /^\d+$/.test(ptid)
          ? Number(ptid)
          : null;
    submitted = {
      mode: 'pickup',
      pickup: {
        address_id: addressId,
        pickup_time_id: ptid || undefined,
        pickup_time:
          epoch != null && Number.isFinite(epoch)
            ? (() => {
                const h = formatPickupHuman(epoch, tz);
                return {
                  date_unix: epoch,
                  date_long: h.date_local_long,
                  datetime: h.datetime_local,
                  calendar_date: h.date_local_iso,
                  time_zone: h.time_zone,
                };
              })()
            : ptid
              ? { pickup_time_id: ptid, note: 'Could not parse slot time for display.' }
              : undefined,
      },
    };
  } else if (shipBody.dropoff && typeof shipBody.dropoff === 'object') {
    submitted = { mode: 'dropoff', dropoff: shipBody.dropoff };
  } else if (shipBody.non_integrated && typeof shipBody.non_integrated === 'object') {
    submitted = { mode: 'non_integrated', non_integrated: shipBody.non_integrated };
  }

  return {
    marketplace: 'shopee',
    order_sn: orderSn,
    split_order: isSplitOrder,
    package_number_used: packageNumberUsed,
    shipping: {
      paths_available: paths,
      pickup_options,
      submitted,
    },
    ship_order: {
      ok: !shipRes.error,
      error: shipRes.error || undefined,
      message: shipRes.message || undefined,
      request_id: shipRes.request_id,
      warning: shipRes.warning || undefined,
    },
    api: {
      get_shipping_parameter_request_id: sp.request_id,
      ship_order_request_id: shipRes.request_id,
    },
    ...(flags.retried_without_package_number
      ? { retried_without_package_number: true }
      : {}),
  };
}

type ShipPayloadBuild =
  | { ok: true; body: Record<string, unknown> }
  | { ok: false; message: string; needsHandoverChoice?: boolean };

/**
 * Build `ship_order` body with exactly one of pickup / dropoff / non_integrated (Shopee requirement).
 * When **both** pickup and drop-off are available (non-instant integrations), pass `handover: 'pickup' | 'dropoff'`.
 * Omit `handover` only when a single path is available (e.g. SPX Instant = pickup only).
 * `packageNumber` must only be set for **split** orders; unsplit orders must omit it or Shopee returns
 * `logistics.ship_order_not_need_pacakge_number`.
 * @see v2.logistics.get_shipping_parameter → v2.logistics.ship_order
 */
function buildShipOrderPayload(
  orderSn: string,
  packageNumberForShipOrder: string | undefined,
  sp: NonNullable<ShopeeShippingParameterResponse['response']>,
  handover?: 'pickup' | 'dropoff',
): ShipPayloadBuild {
  const body: Record<string, unknown> = { order_sn: orderSn };
  if (packageNumberForShipOrder) body.package_number = packageNumberForShipOrder;

  const info = sp.info_needed;
  const pickupAddrs = sp.pickup?.address_list ?? [];
  const dropoffBranches = sp.dropoff?.branch_list ?? [];
  const slugList = sp.dropoff?.slug_list ?? [];

  const pickupFields = info?.pickup?.length ?? 0;
  const dropoffFields = info?.dropoff?.length ?? 0;
  const nonIntFields = info?.non_integrated?.length ?? 0;

  const canPickup = pickupFields > 0 || pickupAddrs.length > 0;
  const canDropoff = dropoffFields > 0 || dropoffBranches.length > 0 || slugList.length > 0;

  const pickupReady = canPickup && pickupAddrs.length > 0;
  const dropoffReady = canDropoff && (dropoffBranches.length > 0 || slugList.length > 0);
  const bothHandoverOptions = pickupReady && dropoffReady;

  const buildPickup = (): ShipPayloadBuild => {
    const addr = pickupAddrs[0];
    const pickupPayload: Record<string, unknown> = { address_id: addr.address_id };
    const slot = addr.time_slot_list?.[0];
    if (slot?.pickup_time_id) pickupPayload.pickup_time_id = slot.pickup_time_id;
    body.pickup = pickupPayload;
    return { ok: true, body };
  };

  const buildDropoff = (): ShipPayloadBuild => {
    const needsSenderRealName = info?.dropoff?.includes('sender_real_name');
    if (needsSenderRealName) {
      return {
        ok: false,
        message:
          'Shopee dropoff requires `sender_real_name`. Set it in Shopee Seller Centre or extend confirm-order-fulfillment with an optional sender name field.',
      };
    }
    const dropoffPayload: Record<string, unknown> = {};
    const branch = dropoffBranches[0];
    if (branch?.branch_id != null) dropoffPayload.branch_id = branch.branch_id;
    const slug = slugList[0]?.slug;
    if (slug) dropoffPayload.slug = slug;
    if (Object.keys(dropoffPayload).length === 0) {
      return {
        ok: false,
        message:
          'Shopee dropoff is required but no branch_id or slug returned from get_shipping_parameter. Check logistics setup for this order.',
      };
    }
    body.dropoff = dropoffPayload;
    return { ok: true, body };
  };

  if (handover === 'pickup') {
    if (!pickupReady) {
      return {
        ok: false,
        message:
          'Shopee pickup was requested but get_shipping_parameter returned no pickup address/time slots for this order.',
      };
    }
    return buildPickup();
  }

  if (handover === 'dropoff') {
    if (!dropoffReady) {
      return {
        ok: false,
        message:
          'Shopee drop-off was requested but get_shipping_parameter returned no branch/slug for this order.',
      };
    }
    return buildDropoff();
  }

  if (bothHandoverOptions) {
    return {
      ok: false,
      needsHandoverChoice: true,
      message:
        'Shopee offers both **pick-up** and **drop-off** for this order (e.g. Sandbox J&T). Re-call confirm-order-fulfillment with `shopeeHandover: "pickup"` (jemput ke alamat) or `shopeeHandover: "dropoff"` (antar ke counter), or run create-fulfillment-package first to see `details.handover`.',
    };
  }

  if (pickupReady) {
    return buildPickup();
  }

  if (dropoffReady) {
    return buildDropoff();
  }

  if (nonIntFields > 0 || (!pickupReady && !dropoffReady)) {
    const needsTracking = info?.non_integrated?.includes('tracking_number');
    if (needsTracking) {
      return {
        ok: false,
        message:
          'Shopee non_integrated channel requires a `tracking_number` for ship_order. Add tracking in Seller Centre or extend the tool to pass it.',
      };
    }
    body.non_integrated = {};
    return { ok: true, body };
  }

  return {
    ok: false,
    message:
      'Could not build Shopee ship_order: no pickup addresses, dropoff branches, or non_integrated path from get_shipping_parameter. Order may not be LOGISTICS_READY yet.',
  };
}

function handoverAvailabilityFromSp(
  sp: NonNullable<ShopeeShippingParameterResponse['response']>,
): {
  pickup_available: boolean;
  dropoff_available: boolean;
  needs_handover_choice: boolean;
  info_needed_pickup: string[];
  info_needed_dropoff: string[];
} {
  const info = sp.info_needed;
  const pickupAddrs = sp.pickup?.address_list ?? [];
  const dropoffBranches = sp.dropoff?.branch_list ?? [];
  const slugList = sp.dropoff?.slug_list ?? [];
  const pickupFields = info?.pickup?.length ?? 0;
  const dropoffFields = info?.dropoff?.length ?? 0;
  const canPickup = pickupFields > 0 || pickupAddrs.length > 0;
  const canDropoff = dropoffFields > 0 || dropoffBranches.length > 0 || slugList.length > 0;
  const pickupReady = canPickup && pickupAddrs.length > 0;
  const dropoffReady = canDropoff && (dropoffBranches.length > 0 || slugList.length > 0);
  return {
    pickup_available: pickupReady,
    dropoff_available: dropoffReady,
    needs_handover_choice: pickupReady && dropoffReady,
    info_needed_pickup: info?.pickup ?? [],
    info_needed_dropoff: info?.dropoff ?? [],
  };
}

/**
 * Call after get-order-details (or search): summarizes Seller Centre “Atur pengiriman” vs instant flow
 * using `v2.logistics.get_shipping_parameter`.
 */
export async function previewShopeeHandover(client: ShopeeClient, orderSn: string): Promise<{
  order_sn: string;
  pickup_available: boolean;
  dropoff_available: boolean;
  needs_handover_choice: boolean;
  instant_suspected: boolean;
  carrier?: string;
  package_number_used?: string;
  info_needed_pickup: string[];
  info_needed_dropoff: string[];
}> {
  const trimmed = orderSn.trim();
  const detailMap = await getShopeeOrderDetails(client, [trimmed], false);
  const detail = detailMap.get(trimmed);
  const carrier = detail?.shippingProvider;
  const instant_suspected = /\binstant\b/i.test(carrier ?? '');
  const packageIds = detail?.packageIds ?? [];
  const isSplit = packageIds.length > 1;
  const splitFirst = isSplit ? packageIds[0] : undefined;
  const singleFallback = !isSplit && packageIds.length === 1 ? packageIds[0] : undefined;

  const { sp, package_number_queried } = await fetchGetShippingParameter(client, trimmed, {
    splitFirstPackage: splitFirst,
    singlePackageFallback: singleFallback,
  });
  const spData = sp.response;
  if (!spData) {
    throw new Error(
      `Shopee get_shipping_parameter failed: ${sp.error ?? 'unknown'} ${sp.message ?? ''}`.trim(),
    );
  }
  const h = handoverAvailabilityFromSp(spData);
  return {
    order_sn: trimmed,
    pickup_available: h.pickup_available,
    dropoff_available: h.dropoff_available,
    needs_handover_choice: h.needs_handover_choice,
    instant_suspected,
    carrier,
    package_number_used: package_number_queried ?? splitFirst,
    info_needed_pickup: h.info_needed_pickup,
    info_needed_dropoff: h.info_needed_dropoff,
  };
}

/**
 * Confirm/ship a Shopee order (`order_sn`).
 * Loads shipping parameters via get_shipping_parameter, then ship_order with exactly one logistics mode.
 */
export async function confirmShopeeFulfillment(
  client: ShopeeClient,
  id: string,
  options?: { shopeeHandover?: 'pickup' | 'dropoff' },
): Promise<FulfillmentResult> {
  const orderSn = id.trim();
  if (!orderSn) {
    return {
      id,
      platform: 'shopee',
      success: false,
      message: 'Empty order id.',
    };
  }

  try {
    let packageIds: string[] = [];
    let carrier: string | undefined;
    try {
      const details = await getShopeeOrderDetails(client, [orderSn], false);
      const row = details.get(orderSn);
      if (!row) {
        return {
          id: orderSn,
          platform: 'shopee',
          success: false,
          message:
            `Shopee get_order_detail returned no data for order_sn "${orderSn}". Pass the same **shopId** (external_shop_id) as on the search-orders row for this shop; the wrong connection commonly produces logistics.order_not_exist on get_shipping_parameter.`,
        };
      }
      packageIds = row.packageIds ?? [];
      carrier = row.shippingProvider;
    } catch {
      // Detail fetch failed — continue; rare channels might still proceed
    }

    const isSplitOrder = packageIds.length > 1;
    const packageNumberForShipOrder = isSplitOrder ? packageIds[0] : undefined;
    const splitFirst = isSplitOrder ? packageIds[0] : undefined;
    const singlePackageFallback = !isSplitOrder && packageIds.length === 1 ? packageIds[0] : undefined;

    const { sp } = await fetchGetShippingParameter(client, orderSn, {
      splitFirstPackage: splitFirst,
      singlePackageFallback,
    });
    const spData = sp.response;
    if (!spData) {
      return {
        id: orderSn,
        platform: 'shopee',
        success: false,
        message: `Shopee get_shipping_parameter failed: ${sp.error ?? 'unknown'} ${sp.message ?? ''}`.trim(),
        raw: sp,
      };
    }

    const built = buildShipOrderPayload(orderSn, packageNumberForShipOrder, spData, options?.shopeeHandover);
    if (!built.ok) {
      const h = handoverAvailabilityFromSp(spData);
      const instantSuspected = /\binstant\b/i.test(carrier ?? '');
      return {
        id: orderSn,
        platform: 'shopee',
        success: false,
        message: built.message,
        details: {
          ...h,
          needs_shopee_handover_choice: built.needsHandoverChoice === true,
          instant_suspected: instantSuspected,
          carrier,
          instant_flow_note: instantSuspected
            ? 'Instant logistics: API usually exposes pickup only — call confirm-order-fulfillment **without** `shopeeHandover` when `needs_handover_choice` is false. Successful `ship_order` aligns with Seller Centre processing / label prep.'
            : undefined,
        },
        raw: { get_shipping_parameter: sp },
      };
    }

    const postShipOrder = async (body: Record<string, unknown>) =>
      client.post<ShopeeShipOrderResponse>(SHOPEE_SHIP_ORDER_PATH, { body });

    try {
      const res = await postShipOrder(built.body);
      return {
        id: orderSn,
        platform: 'shopee',
        success: true,
        message: 'Shopee ship_order submitted.',
        details: buildShopeeFulfillmentDetails(
          orderSn,
          isSplitOrder,
          packageNumberForShipOrder,
          sp,
          res,
          built.body,
        ),
        raw: { get_shipping_parameter: sp, ship_order: res },
      };
    } catch (firstErr) {
      const msg = firstErr instanceof Error ? firstErr.message : String(firstErr);
      const shouldRetryWithoutPkg =
        typeof built.body.package_number === 'string' &&
        /ship_order_not_need_(pacakge|package)_number|don\W*t .*package_number|unsplit order/i.test(
          msg,
        );

      if (shouldRetryWithoutPkg) {
        const retryBody = { ...built.body };
        delete retryBody.package_number;
        const res = await postShipOrder(retryBody);
        return {
          id: orderSn,
          platform: 'shopee',
          success: true,
          message: 'Shopee ship_order submitted.',
          details: buildShopeeFulfillmentDetails(
            orderSn,
            isSplitOrder,
            undefined,
            sp,
            res,
            retryBody,
            { retried_without_package_number: true },
          ),
          raw: { get_shipping_parameter: sp, ship_order: res, retried_without_package_number: true },
        };
      }
      throw firstErr;
    }
  } catch (err) {
    return {
      id: orderSn,
      platform: 'shopee',
      success: false,
      message: (err as Error).message,
    };
  }
}
