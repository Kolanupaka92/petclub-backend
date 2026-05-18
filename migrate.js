require('dotenv').config();
const { Client } = require('pg');
const fs = require('fs');
const path = require('path');

async function migrate() {
  // sslmode=require in URL + rejectUnauthorized:false + explicit servername for SNI
  const client = new Client({
    connectionString: 'postgresql://postgres.zjrgbsrsthtmxkislgcm:Petclub%402026@aws-0-ap-south-1.pooler.supabase.com:5432/postgres?sslmode=require',
    ssl: { rejectUnauthorized: false, servername: 'aws-0-ap-south-1.pooler.supabase.com' },
    connectionTimeoutMillis: 20000,
  });

  try {
    await client.connect();
    console.log('Connected to Supabase!');

    const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');

    // Split on semicolons and execute each statement
    const statements = schema
      .split(';')
      .map(s => s.trim())
      .filter(s => s.length > 0 && !s.startsWith('--'));

    for (const stmt of statements) {
      try {
        await client.query(stmt);
        const match = stmt.match(/CREATE TABLE.*?(\w+)\s*\(/i);
        if (match) console.log('Created table:', match[1]);
      } catch (e) {
        if (!e.message.includes('already exists')) {
          console.error('Statement error:', e.message, '\nSQL:', stmt.slice(0, 80));
        }
      }
    }

    console.log('Migration complete!');
  } catch (err) {
    console.error('Connection error:', err.message);
    console.error('Code:', err.code);
  } finally {
    await client.end();
  }
}

migrate();
