'use strict';
/**
 * ══════════════════════════════════════════════════════════════════
 *  Supabase Mock Factory
 *  tests/helpers/mockSupabase.js
 * ══════════════════════════════════════════════════════════════════
 *
 * Creates a lightweight, chainable Supabase client mock.
 * Every method returns `this` so chained calls like:
 *   supabase.from('users').select('*').eq('id', x).single()
 * resolve to the final `resolveValue` you configure.
 *
 * Usage:
 *   const sb = makeMockSupabase({ data: { loyalty_points: 50 }, error: null });
 *   sb.rpc.mockResolvedValueOnce({ data: { success: true, new_balance: 0 }, error: null });
 * ══════════════════════════════════════════════════════════════════
 */

/**
 * Build one chainable query builder stub.
 * Every terminal method (single, then, etc.) resolves to `resolveValue`.
 */
function makeQueryBuilder(resolveValue) {
  const builder = {
    select:  jest.fn().mockReturnThis(),
    insert:  jest.fn().mockReturnThis(),
    update:  jest.fn().mockReturnThis(),
    delete:  jest.fn().mockReturnThis(),
    upsert:  jest.fn().mockReturnThis(),
    eq:      jest.fn().mockReturnThis(),
    neq:     jest.fn().mockReturnThis(),
    gt:      jest.fn().mockReturnThis(),
    lt:      jest.fn().mockReturnThis(),
    gte:     jest.fn().mockReturnThis(),
    lte:     jest.fn().mockReturnThis(),
    not:     jest.fn().mockReturnThis(),
    is:      jest.fn().mockReturnThis(),
    in:      jest.fn().mockReturnThis(),
    order:   jest.fn().mockReturnThis(),
    limit:   jest.fn().mockReturnThis(),
    // Terminal — resolves the chain
    single:  jest.fn().mockResolvedValue(resolveValue),
    // Make the builder itself thenable so `await supabase.from(...).insert(...)` works
    then: (resolve) => resolve(resolveValue),
  };
  return builder;
}

/**
 * Create a full mock Supabase client.
 *
 * @param {object} [defaultResolve={ data: null, error: null }]
 *   Default value all terminal methods resolve to. Override per-call with
 *   builder.single.mockResolvedValueOnce(...) on the returned object.
 *
 * @returns {{ from: jest.Mock, rpc: jest.Mock, _builder: object }}
 *   _builder exposes the query builder so tests can override individual calls.
 */
function makeMockSupabase(defaultResolve = { data: null, error: null }) {
  const builder = makeQueryBuilder(defaultResolve);
  const client = {
    from: jest.fn().mockReturnValue(builder),
    rpc:  jest.fn().mockResolvedValue(defaultResolve),
    // Expose internals for per-test overrides
    _builder: builder,
  };
  return client;
}

/**
 * Shorthand — build a mock that returns `data` with no error.
 */
function ok(data) {
  return makeMockSupabase({ data, error: null });
}

/**
 * Shorthand — build a mock that always returns an error.
 */
function fail(message = 'DB error') {
  return makeMockSupabase({ data: null, error: { message } });
}

module.exports = { makeMockSupabase, ok, fail };
