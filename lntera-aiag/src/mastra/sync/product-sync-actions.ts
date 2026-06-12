// Applies a user's token-free decision on a product_mappings link (no LLM). Called by the REST
// endpoint after it has authenticated the tenant. Idempotent: a choice already reflected in the
// mapping's terminal state is a no-op. The endpoint verifies link.tenant_id === caller tenant.
import { getConnectionById } from '../integrations/shared/supabase';
import { fetchNormalizedProductDetail } from '../integrations/shared/product-detail-fetch';
import { normalizedToTenantProduct } from '../integrations/products/product-mapper';
import { deleteTenantProduct, upsertTenantProductWithEmbedding } from '../integrations/products/tenant-products-repo';
import { getMappingById, updateMapping, type ProductMappingRow } from '../integrations/products/product-mappings-repo';
import { setSyncPrefs } from '../integrations/shared/sync-prefs';

export type ProductSyncChoice =
  | 'create'
  | 'create_always'
  | 'map'
  | 'map_always'
  | 'skip'
  | 'ignore'
  | 'undo';

const VALID_CHOICES: ProductSyncChoice[] = [
  'create',
  'create_always',
  'map',
  'map_always',
  'skip',
  'ignore',
  'undo',
];

export interface ApplyActionResult {
  ok: boolean;
  status: 'applied' | 'noop' | 'not_found' | 'forbidden' | 'invalid' | 'error';
  message: string;
  mappingStatus?: string;
  prefUpdated?: 'auto_create_new' | 'auto_map_high_confidence';
}

function suggestedProductId(mapping: ProductMappingRow): string | null {
  if (mapping.internal_product_id) return mapping.internal_product_id;
  const raw = mapping.raw as { suggestedProductId?: unknown } | null;
  const id = raw?.suggestedProductId;
  return typeof id === 'string' && id ? id : null;
}

export async function applyProductSyncAction(args: {
  tenantId: string;
  linkId: string;
  choice: string;
}): Promise<ApplyActionResult> {
  if (!VALID_CHOICES.includes(args.choice as ProductSyncChoice)) {
    return { ok: false, status: 'invalid', message: `Unknown action "${args.choice}".` };
  }
  const choice = args.choice as ProductSyncChoice;

  const mapping = await getMappingById(args.linkId);
  if (!mapping) return { ok: false, status: 'not_found', message: 'That product link no longer exists.' };
  if (mapping.tenant_id !== args.tenantId) {
    return { ok: false, status: 'forbidden', message: 'You do not have access to that product link.' };
  }

  // Idempotent terminal-state short-circuits.
  if ((choice === 'map' || choice === 'map_always') && mapping.status === 'confirmed') {
    return { ok: true, status: 'noop', message: 'Already linked.', mappingStatus: mapping.status };
  }
  if ((choice === 'create' || choice === 'create_always') && mapping.status === 'new_created') {
    return { ok: true, status: 'noop', message: 'Already added to your catalog.', mappingStatus: mapping.status };
  }
  if ((choice === 'skip' || choice === 'ignore') && (mapping.status === 'ignored' || mapping.status === 'rejected')) {
    return { ok: true, status: 'noop', message: 'Already dismissed.', mappingStatus: mapping.status };
  }
  if (choice === 'undo' && mapping.status === 'rejected') {
    return { ok: true, status: 'noop', message: 'Already undone.', mappingStatus: mapping.status };
  }

  try {
    switch (choice) {
      case 'create':
      case 'create_always': {
        const connection = await getConnectionById(mapping.marketplace_connection_id);
        if (!connection) return { ok: false, status: 'error', message: 'The marketplace connection is no longer available.' };
        const detail = await fetchNormalizedProductDetail({
          connection,
          productId: mapping.external_product_id,
        });
        if (!detail) {
          return { ok: false, status: 'error', message: 'Could not fetch the product from the marketplace.' };
        }
        const { productId } = await upsertTenantProductWithEmbedding(
          normalizedToTenantProduct(detail, { tenantId: args.tenantId, connectionId: connection.id }),
          { existingProductId: mapping.internal_product_id ?? null },
        );
        await updateMapping(mapping.id, {
          status: 'new_created',
          matchedBy: 'user',
          internalProductId: productId,
          touchMatchedAt: true,
        });
        let prefUpdated: ApplyActionResult['prefUpdated'];
        if (choice === 'create_always') {
          await setSyncPrefs(args.tenantId, { autoCreateNew: true });
          prefUpdated = 'auto_create_new';
        }
        return {
          ok: true,
          status: 'applied',
          message:
            choice === 'create_always'
              ? 'Added to your catalog. New products will be added automatically from now on.'
              : 'Added to your catalog.',
          mappingStatus: 'new_created',
          prefUpdated,
        };
      }

      case 'map':
      case 'map_always': {
        const internalId = suggestedProductId(mapping);
        if (!internalId) {
          return { ok: false, status: 'error', message: 'There is no suggested product to link.' };
        }
        await updateMapping(mapping.id, {
          status: 'confirmed',
          matchedBy: 'user',
          internalProductId: internalId,
          touchMatchedAt: true,
        });
        let prefUpdated: ApplyActionResult['prefUpdated'];
        if (choice === 'map_always') {
          await setSyncPrefs(args.tenantId, { autoMapHighConfidence: true });
          prefUpdated = 'auto_map_high_confidence';
        }
        return {
          ok: true,
          status: 'applied',
          message:
            choice === 'map_always'
              ? 'Linked. Strong matches will be linked automatically from now on.'
              : 'Linked to your product.',
          mappingStatus: 'confirmed',
          prefUpdated,
        };
      }

      case 'skip':
      case 'ignore': {
        await updateMapping(mapping.id, { status: 'ignored', matchedBy: 'user', touchMatchedAt: true });
        return { ok: true, status: 'applied', message: "Skipped — we won't ask again.", mappingStatus: 'ignored' };
      }

      case 'undo': {
        if (mapping.status === 'new_created' && mapping.internal_product_id) {
          await deleteTenantProduct(args.tenantId, mapping.internal_product_id);
          await updateMapping(mapping.id, {
            status: 'rejected',
            matchedBy: 'user',
            internalProductId: null,
            touchMatchedAt: true,
          });
          return { ok: true, status: 'applied', message: 'Removed from your catalog.', mappingStatus: 'rejected' };
        }
        // auto_mapped (or confirmed) → unlink without deleting the pre-existing product.
        await updateMapping(mapping.id, {
          status: 'rejected',
          matchedBy: 'user',
          internalProductId: null,
          touchMatchedAt: true,
        });
        return { ok: true, status: 'applied', message: 'Unlinked.', mappingStatus: 'rejected' };
      }

      default:
        return { ok: false, status: 'invalid', message: `Unknown action "${choice}".` };
    }
  } catch (err) {
    return {
      ok: false,
      status: 'error',
      message: err instanceof Error ? err.message : 'Failed to apply the action.',
    };
  }
}
