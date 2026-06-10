import type { ShopeeClient } from './client';

const SHOPEE_GET_SHOP_INFO_PATH = '/api/v2/shop/get_shop_info';

interface ShopeeShopInfoFields {
  shop_name?: string;
  region?: string;
  status?: string;
  description?: string;
  shop_logo?: string;
}

/** Product APIs nest under `response`; `get_shop_info` returns fields at the top level. */
type ShopeeGetShopInfoResponse = { response?: ShopeeShopInfoFields } & ShopeeShopInfoFields;

function unwrapShopInfoPayload(res: ShopeeGetShopInfoResponse): ShopeeShopInfoFields {
  if (res.response && typeof res.response === 'object') return res.response;
  return res;
}

export interface ShopeeShopInfo {
  shopName: string | null;
  region: string | null;
  status: string | null;
}

export async function getShopeeShopInfo(client: ShopeeClient): Promise<ShopeeShopInfo> {
  const res = await client.get<ShopeeGetShopInfoResponse>(SHOPEE_GET_SHOP_INFO_PATH);
  const r = unwrapShopInfoPayload(res);
  return {
    shopName: typeof r.shop_name === 'string' ? r.shop_name : null,
    region: typeof r.region === 'string' ? r.region : null,
    status: typeof r.status === 'string' ? r.status : null,
  };
}
