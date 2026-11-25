'use strict';
/**
 * Small in-memory Supabase fake that APPLIES filters, so tests can assert on
 * which rows a query really touches. Like the real client, its builders are
 * thenables with no .catch(), and errors resolve as { error }.
 */
function makeFakeSupabase(tables = {}, failing = {}) {
  const from = (name) => {
    const filters = [];
    let op = 'select', patch = null, single = false;
    const run = () => {
      if (failing[`${name}.${op}`]) return { data: null, error: { message: failing[`${name}.${op}`] } };
      const all = (tables[name] = tables[name] || []);
      const hit = all.filter(r => filters.every(f => f(r)));
      if (op === 'update') hit.forEach(r => Object.assign(r, patch));
      if (op === 'delete') tables[name] = all.filter(r => !hit.includes(r));
      const data = hit.map(r => ({ ...r }));
      return { data: single ? data[0] || null : data, error: null };
    };
    const b = {
      select: () => b,
      update: (p) => { op = 'update'; patch = p; return b; },
      delete: () => { op = 'delete'; return b; },
      insert: (row) => { (tables[name] = tables[name] || []).push(row); return b; },
      eq:  (c, v) => { filters.push(r => r[c] === v); return b; },
      neq: (c, v) => { filters.push(r => r[c] !== v); return b; },
      is:  (c, v) => { filters.push(r => (r[c] ?? null) === v); return b; },
      in:  (c, v) => { filters.push(r => v.includes(r[c])); return b; },
      gt:  (c, v) => { filters.push(r => r[c] > v); return b; },
      gte: (c, v) => { filters.push(r => r[c] >= v); return b; },
      lt:  (c, v) => { filters.push(r => r[c] < v); return b; },
      ilike: (c, v) => { const t = v.replace(/\\(.)/g, '$1').toLowerCase(); filters.push(r => String(r[c] || '').toLowerCase() === t); return b; },
      upsert: (row) => { (tables[name] = tables[name] || []).push(row); return b; },
      order: () => b, limit: () => b, range: () => b,
      single: () => { single = true; return b; },
      maybeSingle: () => { single = true; return b; },
      then: (ok, bad) => Promise.resolve().then(run).then(ok, bad),
    };
    return b;
  };
  return { from, tables };
}
module.exports = { makeFakeSupabase };
