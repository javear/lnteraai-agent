import type { ShopeeClient } from './client';
import type { ShippingLabelResult } from '../shared/shipping-labels';
import { getShopeeOrderDetails } from './orders';

const SHOPEE_GET_SHIPPING_DOCUMENT_PARAMETER = '/api/v2/logistics/get_shipping_document_parameter';
const SHOPEE_CREATE_SHIPPING_DOCUMENT = '/api/v2/logistics/create_shipping_document';
const SHOPEE_GET_SHIPPING_DOCUMENT_RESULT = '/api/v2/logistics/get_shipping_document_result';
const SHOPEE_DOWNLOAD_SHIPPING_DOCUMENT = '/api/v2/logistics/download_shipping_document';

const POLL_MAX_ATTEMPTS = 18;
const POLL_MS = 1500;
const EMBED_MAX_BYTES = 750_000;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

/** Shopee logistics shipping-document APIs expect `order_list`, not top-level `order_sn`. */
function buildOrderListBody(
  orderSn: string,
  packageNumber: string | undefined,
): { order_list: Array<Record<string, unknown>> } {
  const item: Record<string, unknown> = { order_sn: orderSn };
  if (packageNumber) item.package_number = packageNumber;
  return { order_list: [item] };
}

/** Pick Shopee `shipping_document_type` from get_shipping_document_parameter response. */
function pickShippingDocumentType(parameterResponse: unknown): string | null {
  const root = asRecord(parameterResponse);
  const resp = asRecord(root?.response) ?? root;
  if (!resp) return null;

  const fromOne = (r: Record<string, unknown>): string | null => {
    const direct =
      r.suggest_shipping_document_type ??
      r.recommended_document_type ??
      r.shipping_document_type;
    if (typeof direct === 'string' && direct.trim()) return direct.trim();

    const optList = r.option_list ?? r.document_type_list ?? r.shipping_document_type_list;
    if (Array.isArray(optList) && optList.length > 0) {
      const first = optList[0];
      const o = asRecord(first);
      if (o) {
        const t =
          o.shipping_document_type ?? o.document_type ?? o.type ?? o.name ?? o.code;
        if (typeof t === 'string' && t.trim()) return t.trim();
      }
      if (typeof first === 'string' && first.trim()) return first.trim();
    }
    return null;
  };

  const batched = resp.result_list ?? resp.order_list;
  if (Array.isArray(batched) && batched.length > 0) {
    const row = asRecord(batched[0]);
    if (row) {
      const inner = asRecord(row.parameter) ?? asRecord(row.response) ?? asRecord(row.result) ?? row;
      const t = fromOne(inner);
      if (t) return t;
    }
  }

  return fromOne(resp);
}

function resultDocStatus(resultResponse: unknown): string | null {
  const root = asRecord(resultResponse);
  const resp = asRecord(root?.response) ?? root;
  if (!resp) return null;

  const batched = resp.result_list ?? resp.order_list;
  if (Array.isArray(batched) && batched.length > 0) {
    const row = asRecord(batched[0]);
    if (row) {
      const inner = asRecord(row.result) ?? asRecord(row.response) ?? row;
      const st =
        inner.status ??
        inner.result_status ??
        inner.shipping_document_status ??
        (asRecord(inner.response)?.status as string | undefined);
      if (typeof st === 'string') return st;
    }
  }

  const st = resp.status ?? resp.result_status ?? resp.shipping_document_status;
  return typeof st === 'string' ? st : null;
}

function extractLabelFromDownloadPayload(
  data: unknown,
): { url?: string; base64?: string; hint?: string } {
  const root = asRecord(data);
  const resp = asRecord(root?.response) ?? root;
  if (!resp) return {};
  const doc = asRecord(resp.shipping_document) ?? asRecord(resp.document) ?? resp;
  if (!doc) return {};

  const url =
    [doc.url, doc.file_url, doc.download_url, doc.label_url, doc.shipping_document_url].find(
      (x) => typeof x === 'string' && x.startsWith('http'),
    ) ?? undefined;

  const base64 =
    [doc.file, doc.pdf_file, doc.content, doc.document, doc.base64].find((x) => typeof x === 'string') ??
    undefined;

  return {
    url: url as string | undefined,
    base64: base64 as string | undefined,
    hint: typeof doc.status === 'string' ? doc.status : undefined,
  };
}

async function shopeeLabelFlow(
  client: ShopeeClient,
  orderSn: string,
  packageNumber: string | undefined,
  embedDocument: boolean,
): Promise<{
  label: Record<string, unknown>;
  rawSteps: unknown[];
}> {
  const rawSteps: unknown[] = [];

  const paramBody = buildOrderListBody(orderSn, packageNumber);

  const paramRes = await client.post<unknown>(SHOPEE_GET_SHIPPING_DOCUMENT_PARAMETER, { body: paramBody });
  rawSteps.push({ step: 'get_shipping_document_parameter', response: paramRes });

  const docType = pickShippingDocumentType(paramRes);
  if (!docType) {
    throw new Error(
      'Shopee get_shipping_document_parameter did not return a usable shipping_document_type. Check order status and logistics channel.',
    );
  }

  const createBody: Record<string, unknown> = {
    ...buildOrderListBody(orderSn, packageNumber),
    shipping_document_type: docType,
  };

  const createRes = await client.post<unknown>(SHOPEE_CREATE_SHIPPING_DOCUMENT, { body: createBody });
  rawSteps.push({ step: 'create_shipping_document', response: createRes });

  let status: string | null = null;
  for (let i = 0; i < POLL_MAX_ATTEMPTS; i++) {
    const resultBody = buildOrderListBody(orderSn, packageNumber);

    const resultRes = await client.post<unknown>(SHOPEE_GET_SHIPPING_DOCUMENT_RESULT, { body: resultBody });
    rawSteps.push({ step: 'get_shipping_document_result', attempt: i + 1, response: resultRes });
    status = resultDocStatus(resultRes);
    const up = status?.toUpperCase() ?? '';
    if (up === 'READY' || up === 'SUCCESS') break;
    if (up === 'FAILED' || up === 'FAIL') {
      throw new Error(`Shopee shipping document generation failed (get_shipping_document_result status=${status}).`);
    }
    await sleep(POLL_MS);
  }
  if (status?.toUpperCase() !== 'READY' && status?.toUpperCase() !== 'SUCCESS') {
    throw new Error(
      `Shopee shipping document not ready after polling (last status=${status ?? 'unknown'}). Retry later or check Seller Centre.`,
    );
  }

  const dlBody = buildOrderListBody(orderSn, packageNumber);

  const dl = await client.postBinaryOrJson(SHOPEE_DOWNLOAD_SHIPPING_DOCUMENT, { body: dlBody });
  rawSteps.push({ step: 'download_shipping_document', responseKind: dl.kind });

  const label: Record<string, unknown> = {
    order_sn: orderSn,
    package_number: packageNumber ?? null,
    shipping_document_type: docType,
    result_status: status,
  };

    if (dl.kind === 'binary') {
    label.file_bytes = dl.body.byteLength;
    label.content_type = dl.contentType ?? 'application/octet-stream';
    if (embedDocument && dl.body.byteLength <= EMBED_MAX_BYTES) {
      label.pdf_base64 = Buffer.from(dl.body).toString('base64');
    } else if (embedDocument) {
      label.note = `PDF ${dl.body.byteLength} bytes (omitted; exceeds embed limit ${EMBED_MAX_BYTES}).`;
    }
  } else {
    const extracted = extractLabelFromDownloadPayload(dl.data);
    if (extracted.url) label.download_url = extracted.url;
    if (extracted.base64) {
      if (embedDocument && extracted.base64.length <= EMBED_MAX_BYTES * 1.37) {
        label.pdf_base64 = extracted.base64;
      } else if (embedDocument) {
        label.note = 'Base64 document omitted (too large for embed).';
      } else {
        label.document_base64_length = extracted.base64.length;
      }
    }
    label.download_envelope = dl.data;
  }

  return { label, rawSteps };
}

/**
 * Shopee: run get_shipping_document_parameter → create → poll result → download for one order.
 * Uses package_number from order detail when present (split orders); omits it when unsplit.
 */
export async function fetchShopeeShippingLabelsForOrder(
  client: ShopeeClient,
  orderSn: string,
  options: { embedDocument?: boolean; includeRaw?: boolean } = {},
): Promise<ShippingLabelResult> {
  const trimmed = orderSn.trim();
  if (!trimmed) {
    return { id: orderSn, platform: 'shopee', success: false, message: 'Empty order id.' };
  }

  const embedDocument = options.embedDocument === true;

  try {
    const detailMap = await getShopeeOrderDetails(client, [trimmed], false);
    const detail = detailMap.get(trimmed);
    const pkgIds = detail?.packageIds?.filter(Boolean) ?? [];
    const labels: Record<string, unknown>[] = [];
    const allRaw: unknown[] = [];

    if (pkgIds.length > 1) {
      for (const pkg of pkgIds) {
        const { label, rawSteps } = await shopeeLabelFlow(client, trimmed, String(pkg), embedDocument);
        labels.push(label);
        allRaw.push(...rawSteps);
      }
    } else if (pkgIds.length === 1) {
      const one = String(pkgIds[0]);
      try {
        const r = await shopeeLabelFlow(client, trimmed, undefined, embedDocument);
        labels.push(r.label);
        allRaw.push(...r.rawSteps);
      } catch {
        const r = await shopeeLabelFlow(client, trimmed, one, embedDocument);
        labels.push(r.label);
        allRaw.push(...r.rawSteps);
      }
    } else {
      const r = await shopeeLabelFlow(client, trimmed, undefined, embedDocument);
      labels.push(r.label);
      allRaw.push(...r.rawSteps);
    }

    const details = {
      marketplace: 'shopee',
      order_sn: trimmed,
      labels,
    };

    return {
      id: trimmed,
      platform: 'shopee',
      success: true,
      message:
        labels.length > 1
          ? `Shopee retrieved ${labels.length} shipping label document(s).`
          : 'Shopee shipping label document retrieved.',
      details,
      packageRefs: pkgIds.length > 0 ? pkgIds.map(String) : undefined,
      raw: options.includeRaw ? { steps: allRaw } : undefined,
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
