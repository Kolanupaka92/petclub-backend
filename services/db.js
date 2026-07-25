// ══════════════════════════════════════════════════════════════════
//  DB helpers — soft-delete-safe reads
//
//  activeSelect(supabase, table, cols) returns a supabase-js query
//  builder that is ALREADY filtered to non-deleted rows for the three
//  soft-deleted tables (users, bookings, pets). This makes it impossible
//  to forget `.is('deleted_at', null)` on a read — the historical
//  source of leaked-deleted-row bugs.
//
//  Usage:
//    const { data } = await activeSelect(supabase, 'bookings', '*')
//      .eq('customer_id', id)
//      .order('created_at', { ascending: false });
//
//  Notes:
//   • Reads only. Writes (insert/update/delete) go to the base table via
//     the normal supabase.from(table) — soft delete is an UPDATE of
//     deleted_at, which must target the base table.
//   • For tables without deleted_at, it's a plain select (no-op filter),
//     so it's always safe to use.
// ══════════════════════════════════════════════════════════════════
'use strict';

// Tables that use soft delete (have a deleted_at column).
const SOFT_DELETE_TABLES = new Set(['users', 'bookings', 'pets']);

/**
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 * @param {string} table
 * @param {string} [cols='*']
 * @param {object} [opts] - passed through to .select() (e.g. { count: 'exact' })
 */
function activeSelect(supabase, table, cols = '*', opts) {
  const q = supabase.from(table).select(cols, opts);
  return SOFT_DELETE_TABLES.has(table) ? q.is('deleted_at', null) : q;
}

module.exports = { activeSelect, SOFT_DELETE_TABLES };
