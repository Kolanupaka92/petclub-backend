'use strict';
const { activeSelect, SOFT_DELETE_TABLES } = require('../services/db');

// Minimal supabase-js query-builder stub that records the chain.
function makeStub() {
  const calls = [];
  const builder = {
    select(cols, opts) { calls.push(['select', cols, opts]); return builder; },
    is(col, val) { calls.push(['is', col, val]); return builder; },
    eq(col, val) { calls.push(['eq', col, val]); return builder; },
  };
  return {
    calls,
    from(table) { calls.push(['from', table]); return builder; },
  };
}

describe('activeSelect', () => {
  test.each(['users', 'bookings', 'pets'])('appends deleted_at IS NULL filter for %s', (table) => {
    const sb = makeStub();
    activeSelect(sb, table, '*');
    expect(sb.calls).toEqual([
      ['from', table],
      ['select', '*', undefined],
      ['is', 'deleted_at', null],
    ]);
  });

  test('does NOT filter tables without soft delete', () => {
    const sb = makeStub();
    activeSelect(sb, 'professional_profiles', 'id');
    expect(sb.calls).toEqual([
      ['from', 'professional_profiles'],
      ['select', 'id', undefined],
    ]);
    expect(sb.calls.some(c => c[0] === 'is')).toBe(false);
  });

  test('passes select opts through (count/head)', () => {
    const sb = makeStub();
    activeSelect(sb, 'bookings', 'id', { count: 'exact', head: true });
    expect(sb.calls[1]).toEqual(['select', 'id', { count: 'exact', head: true }]);
    expect(sb.calls[2]).toEqual(['is', 'deleted_at', null]);
  });

  test('returns the builder so further filters chain', () => {
    const sb = makeStub();
    const b = activeSelect(sb, 'users', 'id').eq('is_active', true);
    expect(b).toBeDefined();
    expect(sb.calls).toContainEqual(['eq', 'is_active', true]);
  });

  test('soft-delete table set is the three known tables', () => {
    expect([...SOFT_DELETE_TABLES].sort()).toEqual(['bookings', 'pets', 'users']);
  });
});
