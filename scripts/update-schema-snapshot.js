// Author: Sai Kolanupaka
'use strict';
// Refresh supabase/schema-snapshot.json from the live database (read-only).
//   SUPABASE_URL=... SUPABASE_SERVICE_KEY=... node scripts/update-schema-snapshot.js [--check]
// --check only compares, and fails if they differ.
const fs = require('fs');
const path = require('path');
const FILE = path.join(__dirname, '../supabase/schema-snapshot.json');

(async () => {
  const { SUPABASE_URL: url, SUPABASE_SERVICE_KEY: key } = process.env;
  if (!url || !key) throw new Error('SUPABASE_URL and SUPABASE_SERVICE_KEY are required');
  const r = await fetch(`${url}/rest/v1/`, { headers: { apikey: key, Authorization: `Bearer ${key}` } });
  if (!r.ok) throw new Error(`schema request failed: HTTP ${r.status}`);
  const { definitions = {} } = await r.json();
  const live = Object.fromEntries(Object.keys(definitions).sort().map(t => [t, Object.keys(definitions[t].properties).sort()]));
  if (!Object.keys(live).length) throw new Error('no tables returned');
  const next = JSON.stringify(live, null, 1);
  if (process.argv.includes('--check')) {
    const same = JSON.stringify(JSON.parse(fs.readFileSync(FILE, 'utf8')), null, 1) === next;
    console.log(same ? 'Schema snapshot matches the database.' : 'Schema snapshot is OUT OF DATE.');
    process.exitCode = same ? 0 : 1;
  } else { fs.writeFileSync(FILE, next); console.log(`Saved ${Object.keys(live).length} tables.`); }
})().catch(e => { console.error(e.message); process.exit(1); });
