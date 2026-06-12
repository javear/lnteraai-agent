# Mock product-sync simulations

Drive the **real** marketplace→catalog sync pipeline (embeddings → hybrid match → routing →
mappings → token-free notifications) against the **live DB**, using **synthetic product details** so
no Shopee/TikTok store is ever contacted. A mock `marketplace_connections` row (external_shop_id
`MOCK-…`, `raw_metadata.mock = true`) satisfies the foreign keys; everything created is removable by
that marker.

> Requires the same env as the app (`.env`): `PORTKEY_API_KEY`, `PORTKEY_EMBEDDING_MODEL`,
> `SUPABASE_URL`, `SUPABASE_SECRET_KEY`, `DATABASE_URL`. The scripts load `.env` themselves.

## Run

```bash
# all scenarios for a tenant (also dispatches real notifications to that tenant's app)
npx tsx scripts/mock/mock-product-sync.ts <tenantId> all
#   or: npm run mock:sync -- <tenantId> all

# one scenario
npx tsx scripts/mock/mock-product-sync.ts <tenantId> high-ask

# write the DB but DON'T dispatch notifications (no popup/push/Discord)
npx tsx scripts/mock/mock-product-sync.ts <tenantId> all --no-notify
```

`<tenantId>` is a real `tenant_master` UUID — use your own tenant so the prompts show up in its
Active Agent / Notifications chat with working buttons.

## Scenarios

| name | demonstrates |
| ---- | ------------ |
| `new-ask` | NEW product, auto-create OFF → "add it?" prompt (3 buttons) |
| `new-auto` | NEW product, auto-create ON → created automatically + FYI (Undo) |
| `high-ask` | HIGH-confidence match, auto-map OFF → "link them?" prompt (4 buttons) |
| `high-auto` | HIGH-confidence match, auto-map ON → linked automatically + FYI |
| `medium` | related-but-different → always-ask "might match" prompt |
| `multi-warehouse` | TikTok per-warehouse inventory (2 SKUs × 2 warehouses) + Shopee stock-only (default warehouse) |
| `idempotent` | same listing twice → exactly one mapping row |
| `webhook-rescore` | webhook rename on a created product → refresh only, no duplicate prompt |
| `flood-batch` | 8 NEW products at once → coalesced into ONE batch summary |
| `connect-offer` | store-connected → "import your products now?" offer |
| `actions` | the no-LLM action handler: map / skip / undo |

Matching bands are computed live by the embedding model, so each line logs the **actual**
decision/score. (`create`/`create_always` buttons re-fetch live marketplace detail, so they aren't
mockable here — they're covered by `new-auto` and the real connect flow.)

## Clean up

```bash
# remove all mock data for one tenant (products, skus, inventory, mappings, mock warehouses,
# mock connections) and reset that tenant's sync prefs to defaults
npx tsx scripts/mock/mock-cleanup.ts <tenantId>
#   or: npm run mock:clean -- <tenantId>

# every mock tenant at once
npx tsx scripts/mock/mock-cleanup.ts --all

# also delete the product_sync messages from the Notifications chat thread
npx tsx scripts/mock/mock-cleanup.ts <tenantId> --purge-notifications

# keep the sync prefs as the sim left them
npx tsx scripts/mock/mock-cleanup.ts <tenantId> --keep-prefs
```

Cleanup is scoped strictly to mock-marked data, so it's safe to run on a tenant that also has real
connections. (Empty default warehouses are removed too — they auto-recreate on the next stock write.)
