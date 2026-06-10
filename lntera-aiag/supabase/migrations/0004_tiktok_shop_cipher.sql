-- Dedicated field for TikTok shop cipher (required by product/order APIs).
-- Keeping this separate from raw_metadata makes lookup simpler and stable.

alter table if exists marketplace_connections
  add column if not exists shop_cipher text;

create index if not exists marketplace_connections_shop_cipher_idx
  on marketplace_connections (shop_cipher)
  where shop_cipher is not null;

