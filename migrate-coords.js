/**
 * One-time migration: add GPS coordinate columns
 * Run: node migrate-coords.js
 */
require('dotenv').config();

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY  = process.env.SUPABASE_SERVICE_KEY;
const PROJECT_REF  = SUPABASE_URL.replace('https://', '').replace('.supabase.co', '');

const statements = [
  `ALTER TABLE customer_profiles     ADD COLUMN IF NOT EXISTS address_lat         FLOAT8`,
  `ALTER TABLE customer_profiles     ADD COLUMN IF NOT EXISTS address_lng         FLOAT8`,
  `ALTER TABLE customer_profiles     ADD COLUMN IF NOT EXISTS address_postal_code TEXT`,
  `ALTER TABLE customer_profiles     ADD COLUMN IF NOT EXISTS address_city        TEXT`,
  `ALTER TABLE customer_profiles     ADD COLUMN IF NOT EXISTS address_state       TEXT`,
  `ALTER TABLE professional_profiles ADD COLUMN IF NOT EXISTS address_lat         FLOAT8`,
  `ALTER TABLE professional_profiles ADD COLUMN IF NOT EXISTS address_lng         FLOAT8`,
  `ALTER TABLE professional_profiles ADD COLUMN IF NOT EXISTS address_postal_code TEXT`,
  `ALTER TABLE professional_profiles ADD COLUMN IF NOT EXISTS address_city        TEXT`,
  `ALTER TABLE professional_profiles ADD COLUMN IF NOT EXISTS address_state       TEXT`,
  `ALTER TABLE bookings              ADD COLUMN IF NOT EXISTS address_lat         FLOAT8`,
  `ALTER TABLE bookings              ADD COLUMN IF NOT EXISTS address_lng         FLOAT8`,
];

async function runSQL(query) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/query`, {
    method: 'POST',
    headers: {
      'apikey': SERVICE_KEY,
      'Authorization': `Bearer ${SERVICE_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ query }),
  });
  if (!res.ok) {
    // Try pg-meta endpoint
    const r2 = await fetch(`${SUPABASE_URL.replace('.supabase.co', '.supabase.co')}/pg-meta/v1/query`, {
      method: 'POST',
      headers: {
        'apikey': SERVICE_KEY,
        'Authorization': `Bearer ${SERVICE_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ query }),
    });
    return { ok: r2.ok, status: r2.status, body: await r2.text() };
  }
  return { ok: true, status: res.status };
}

(async () => {
  console.log(`Project: ${PROJECT_REF}`);
  let ok = 0, fail = 0;

  for (const stmt of statements) {
    const short = stmt.replace(/\s+/g, ' ').slice(0, 70);
    try {
      const r = await runSQL(stmt);
      if (r.ok || r.status === 200 || r.status === 204) {
        console.log(`✅  ${short}`);
        ok++;
      } else {
        console.error(`❌  ${short}\n    → ${r.status} ${r.body}`);
        fail++;
      }
    } catch (e) {
      console.error(`❌  ${short}\n    → ${e.message}`);
      fail++;
    }
  }

  console.log(`\nDone: ${ok} ok, ${fail} failed`);
  if (fail > 0) {
    console.log(`\nIf the API calls failed, run this SQL in your Supabase dashboard:`);
    console.log(`https://supabase.com/dashboard/project/${PROJECT_REF}/sql/new\n`);
    console.log(statements.map(s => s + ';').join('\n'));
  }
})();
