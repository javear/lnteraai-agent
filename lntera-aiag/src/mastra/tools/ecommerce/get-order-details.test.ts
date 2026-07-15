import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { getOrderDetailsArgsSchema } from './get-order-details';

describe('getOrderDetailsArgsSchema', () => {
  it('accepts up to 20 orders', () => {
    const orders = Array.from({ length: 20 }, (_, i) => ({
      id: `order-${i}`,
      platform: 'shopee' as const,
    }));
    const result = getOrderDetailsArgsSchema.safeParse({ orders });
    assert.equal(result.success, true);
  });

  it('rejects more than 20 orders — an uncapped batch with includeRaw could alone exceed the agent token budget', () => {
    const orders = Array.from({ length: 21 }, (_, i) => ({
      id: `order-${i}`,
      platform: 'shopee' as const,
    }));
    const result = getOrderDetailsArgsSchema.safeParse({ orders });
    assert.equal(result.success, false);
  });

  it('still requires at least one order', () => {
    const result = getOrderDetailsArgsSchema.safeParse({ orders: [] });
    assert.equal(result.success, false);
  });
});
