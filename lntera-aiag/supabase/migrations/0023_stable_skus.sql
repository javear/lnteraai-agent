-- Stable internal SKUs. Until now upsertTenantProductWithEmbedding FULL-REPLACED tenant_product_skus
-- on every marketplace refresh (delete + re-insert), which churned sku_id and reset tenant_inventory
-- — so internal stock was just a mirror of the last-ingested store, with no independent ledger to
-- apply deltas to. This unique index lets the repo upsert SKUs IN PLACE by their external id, so
-- sku_id stays stable and anchors inventory + product_sku_links + the bidirectional internal ledger.

create unique index if not exists tenant_product_skus_external_uq
  on tenant_product_skus (tenant_id, product_id, external_sku_id) where external_sku_id is not null;
