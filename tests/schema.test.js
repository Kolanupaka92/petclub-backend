// Author: Sai Kolanupaka
'use strict';
// Every column the code reads or writes must exist in the database.
// supabase/schema-snapshot.json is the live schema. After applying a migration,
// refresh it with scripts/update-schema-snapshot.js; never edit it to silence this.
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const schema = require('../supabase/schema-snapshot.json');

/** Index just past the bracket that closes the one at `open`, skipping strings and comments. */
function closeOf(s, open) {
  const pair = { '(': ')', '[': ']', '{': '}' };
  const stack = [pair[s[open]]];
  let i = open + 1;
  while (i < s.length && stack.length) {
    const c = s[i];
    if (c === "'" || c === '"' || c === '`') { const q = c; i++; while (i < s.length && s[i] !== q) i += s[i] === '\\' ? 2 : 1; }
    else if (s.startsWith('//', i)) { while (i < s.length && s[i] !== '\n') i++; }
    else if (s.startsWith('/*', i)) i = s.indexOf('*/', i) + 1;
    else if (pair[c]) stack.push(pair[c]);
    else if (c === stack[stack.length - 1]) stack.pop();
    i++;
  }
  return i;
}
/** Split on top-level commas. */
function parts(s) {
  const out = []; let last = 0, i = 0;
  while (i < s.length) {
    if ("([{".includes(s[i])) i = closeOf(s, i);
    else if ("'\"`".includes(s[i])) { const q = s[i++]; while (i < s.length && s[i] !== q) i += s[i] === '\\' ? 2 : 1; i++; }
    else if (s.startsWith('//', i)) { while (i < s.length && s[i] !== '\n') i++; }
    else if (s[i] === ',') { out.push(s.slice(last, i)); last = ++i; }
    else i++;
  }
  out.push(s.slice(last));
  return out;
}
const strip = (s) => s.replace(/^\s*(\/\/[^\n]*\n\s*|\/\*[\s\S]*?\*\/\s*)*/, '').trim();
const literal = (s) => /^(['"])([^'"]*)\1$/.exec(strip(s))?.[2];
const FILTERS = new Set(['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'is', 'in', 'like', 'ilike', 'not', 'order', 'contains']);
const objectKeys = (src) => {
  const o = strip(src);
  if (!o.startsWith('{')) return [];
  return parts(o.slice(1, closeOf(o, 0) - 1)).map(p => /^['"]?([a-zA-Z_]\w*)['"]?\s*(:|$)/.exec(strip(p))?.[1]).filter(Boolean);
};

function columnsUsed(src, start) {
  const used = []; let i = start;
  for (;;) {
    const m = /^\s*(?:\/\/[^\n]*\n\s*)*\.(\w+)\(/.exec(src.slice(i, i + 400));
    if (!m) return used;
    const open = i + m[0].length - 1, end = closeOf(src, open);
    const args = parts(src.slice(open + 1, end - 1));
    const add = (c, how) => { if (c) used.push({ c, how }); };
    if (['insert', 'update', 'upsert'].includes(m[1])) {
      objectKeys(args[0] || '').forEach(k => add(k, m[1]));
      const oc = /onConflict:\s*'([^']+)'/.exec(args[1] || '')?.[1];
      (oc || '').split(',').forEach(c => add(c.trim(), 'onConflict'));
    } else if (FILTERS.has(m[1])) {
      const c = literal(args[0] || '');
      if (c && /^[a-z_]\w*$/.test(c)) add(c, m[1]);
    } else if (m[1] === 'select') {
      const c = literal(args[0] || '');
      if (c) parts(c).map(p => p.trim()).filter(p => /^[a-z_]\w*$/.test(p)).forEach(p => add(p, 'select'));
    }
    i = end;
  }
}

const files = ['server.js', ...['services', 'routes', 'middleware'].flatMap(d => fs.readdirSync(path.join(root, d)).filter(f => f.endsWith('.js')).map(f => `${d}/${f}`))];

function audit(sources) {
  const problems = []; let checked = 0;
  for (const [file, src] of sources) {
    for (const m of src.matchAll(/\.from\('([a-z_]+)'\)|activeSelect\(supabase, '([a-z_]+)'(?:, ('[^']*'))?[^)]*\)/g)) {
      if (src.slice(Math.max(0, m.index - 20), m.index).trimEnd().endsWith('.storage')) continue;
      const table = m[1] || m[2], line = src.slice(0, m.index).split('\n').length;
      if (!schema[table]) { if (!/storage/.test(src.slice(Math.max(0, m.index - 40), m.index))) problems.push(`${file}:${line} unknown table ${table}`); continue; }
      const used = columnsUsed(src, m.index + m[0].length);
      if (m[3]) parts(literal(m[3]) || '').map(p => p.trim()).filter(p => /^[a-z_]\w*$/.test(p)).forEach(c => used.push({ c, how: 'select' }));
      for (const { c, how } of used) { checked++; if (!schema[table].includes(c)) problems.push(`${file}:${line} ${table}.${c} (${how})`); }
    }
  }
  return { problems, checked };
}

describe('code matches the database schema', () => {
  it('uses only tables and columns that exist', () => {
    const r = audit(files.map(f => [f, fs.readFileSync(path.join(root, f), 'utf8')]));
    expect(r.problems).toEqual([]);
    expect(r.checked).toBeGreaterThan(600);
  });
  it('the check itself catches each kind of mistake', () => {
    const bad = (s) => audit([['x.js', s]]).problems.length;
    expect(bad("supabase.from('pets').insert({ name: 1, nope: f(a, { b: 2 }) })")).toBe(1);
    expect(bad("supabase.from('pets')\n  // note\n  .update({ name }).eq('nope', 1)")).toBe(1);
    expect(bad("supabase.from('pets').select('id, nope, users!x(foo)')")).toBe(1);
    expect(bad("supabase.from('pets').select('*').order('nope')")).toBe(1);
    expect(bad("supabase.from('pets').upsert({ id }, { onConflict: 'nope' })")).toBe(1);
    expect(bad("activeSelect(supabase, 'pets', 'id, nope')")).toBe(1);
    expect(bad("supabase.from('nope').select('*')")).toBe(1);
    expect(bad("supabase.storage.from('id-documents').remove([p])")).toBe(0);
    expect(bad("supabase.from('pets').insert({ name: 'a, nope: b', dob })")).toBe(0);
  });
});
