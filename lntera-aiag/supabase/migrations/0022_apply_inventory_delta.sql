-- Atomic, never-negative inventory delta — returns the new quantity. The bidirectional-sync engine
-- decrements internal stock by "qty sold" with this so concurrent sales on different stores compose
-- without a read-modify-write race, and stock can never go below 0 (clamped via greatest).

create or replace function apply_inventory_delta(p_sku_id uuid, p_warehouse_id uuid, p_delta integer)
returns integer
language plpgsql
as $$
declare
  new_qty integer;
begin
  update tenant_inventory
     set quantity = greatest(0, quantity + p_delta), updated_at = now()
   where sku_id = p_sku_id
     and (warehouse_id = p_warehouse_id or (p_warehouse_id is null and warehouse_id is null))
  returning quantity into new_qty;
  return new_qty;  -- null when no inventory row exists for that (sku, warehouse)
end;
$$;
