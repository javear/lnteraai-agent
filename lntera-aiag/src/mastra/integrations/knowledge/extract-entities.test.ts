import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { extractionSchema } from './extract-entities';

describe('extractionSchema', () => {
  it('truncates an oversized relationship type instead of rejecting it', () => {
    const longType = 'was previously employed as a senior engineer working closely with the leadership team';
    const result = extractionSchema.parse({
      entities: [
        { name: 'Acme Corp', type: 'organization' },
        { name: 'Jane Doe', type: 'person' },
      ],
      relationships: [{ from: 'Jane Doe', to: 'Acme Corp', type: longType }],
    });
    assert.equal(result.relationships[0]?.type.length, 50);
    assert.equal(result.relationships[0]?.type, longType.slice(0, 50));
  });

  it('truncates an oversized entity type the same way', () => {
    const longType = 'a very specific and unnecessarily long category label for this entity';
    const result = extractionSchema.parse({
      entities: [{ name: 'Acme Corp', type: longType }],
      relationships: [],
    });
    assert.equal(result.entities[0]?.type.length, 50);
  });

  it('leaves short types untouched', () => {
    const result = extractionSchema.parse({
      entities: [{ name: 'Acme Corp', type: 'organization' }],
      relationships: [{ from: 'Acme Corp', to: 'Acme Corp', type: 'employs' }],
    });
    assert.equal(result.entities[0]?.type, 'organization');
    assert.equal(result.relationships[0]?.type, 'employs');
  });

  it('still rejects a truly pathological (>300 char) type', () => {
    assert.throws(() => extractionSchema.parse({ entities: [{ name: 'x', type: 'y'.repeat(301) }], relationships: [] }));
  });
});
