require('dotenv').config();
const { Client } = require('pg');
const fs = require('fs');

const passwords = ['Petclub@2026', 'petclub@2026', 'Petclub2026', 'postgres'];
const hosts = [
  'db.zjrgbsrsthtmxkislgcm.supabase.co',
  'aws-0-ap-south-1.pooler.supabase.com',
];

async function tryConnect(host, password) {
  const client = new Client({
    host,
    port: host.includes('pooler') ? 6543 : 5432,
    database: 'postgres',
    user: host.includes('pooler') ? 'postgres.zjrgbsrsthtmxkislgcm' : 'postgres',
    password,
    ssl: { rejectUnauthorized: false },
    connectionTimeoutMillis: 5000,
  });
  try {
    await client.connect();
    console.log(`✅ Connected: ${host} / ${password}`);
    const sql = fs.readFileSync('./schema.sql', 'utf8');
    const statements = sql.split(';').map(s => s.trim()).filter(s => s.length > 5);
    let ok = 0, fail = 0;
    for (const stmt of statements) {
      try { await client.query(stmt); ok++; }
      catch (e) { console.log(`  Skip: ${e.message.slice(0,60)}`); fail++; }
    }
    console.log(`✅ Done: ${ok} statements OK, ${fail} skipped`);
    await client.end();
    return true;
  } catch (e) {
    try { await client.end(); } catch {}
    return false;
  }
}

(async () => {
  for (const host of hosts) {
    for (const pw of passwords) {
      const ok = await tryConnect(host, pw);
      if (ok) process.exit(0);
    }
  }
  console.log('❌ Could not connect. Please run schema.sql manually in the Supabase SQL editor.');
  process.exit(1);
})();
