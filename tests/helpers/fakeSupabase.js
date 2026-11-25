// Author: Sai Kolanupaka
'use strict';
/**
 * Small in-memory Supabase fake that APPLIES filters, so tests can assert on
 * which rows a query really touches. Like the real client, its builders are
 * thenables with no .catch(), and errors resolve as { error }.
 */
const schema = require('../../supabase/schema-snapshot.json');
const unknownColumn = (table, row) => schema[table] && Object.entries(row).find(([k, v]) => v !== undefined && !schema[table].includes(k))?.[0];

function makeFakeSupabase(tables = {}, failing = {}) {
  const from = (name) => {
    const filters = [];
    let op = 'select', patch = null, single = false, badColumn = null, written = null;
    const run = () => {
      if (failing[`${name}.${op}`]) return { data: null, error: { message: failing[`${name}.${op}`] } };
      // Like PostgREST: writing a column that doesn't exist fails the whole write.
      if (badColumn) return { data: null, error: { code: 'PGRST204', message: `Could not find the '${badColumn}' column of '${name}' in the schema cache` } };
      const all = (tables[name] = tables[name] || []);
      const hit = written || all.filter(r => filters.every(f => f(r)));
      if (op === 'update') hit.forEach(r => Object.assign(r, patch));
      if (op === 'delete') tables[name] = all.filter(r => !hit.includes(r));
      const data = hit.map(r => ({ ...r }));
      return { data: single ? data[0] || null : data, error: null };
    };
    const json = (o) => JSON.parse(JSON.stringify(o));   // undefined keys are not sent
    const write = (kind, row, keys) => {
      op = kind;
      const rows = [].concat(row).map(json);
      badColumn = rows.map(r => unknownColumn(name, r)).find(Boolean);
      if (badColumn || failing[`${name}.${kind}`]) return b;
      const all = (tables[name] = tables[name] || []);
      written = rows.map(r => {
        const i = keys.length ? all.findIndex(x => keys.every(k => x[k] === r[k])) : -1;
        if (i >= 0) return Object.assign(all[i], r);
        all.push(r); return r;
      });
      return b;
    };
    const b = {
      select: () => b,
      update: (p) => { op = 'update'; patch = json(p); badColumn = unknownColumn(name, p); return b; },
      delete: () => { op = 'delete'; return b; },
      insert: (row) => write('insert', row, []),
      eq:  (c, v) => { filters.push(r => r[c] === v); return b; },
      neq: (c, v) => { filters.push(r => r[c] !== v); return b; },
      is:  (c, v) => { filters.push(r => (r[c] ?? null) === v); return b; },
      in:  (c, v) => { filters.push(r => v.includes(r[c])); return b; },
      gt:  (c, v) => { filters.push(r => r[c] > v); return b; },
      gte: (c, v) => { filters.push(r => r[c] >= v); return b; },
      lt:  (c, v) => { filters.push(r => r[c] < v); return b; },
      ilike: (c, v) => { const t = v.replace(/\\(.)/g, '$1').toLowerCase(); filters.push(r => String(r[c] || '').toLowerCase() === t); return b; },
      upsert: (row, o = {}) => write('upsert', row, (o.onConflict || '').split(',').map(k => k.trim()).filter(Boolean)),
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
