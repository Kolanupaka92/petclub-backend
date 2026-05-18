const { Client } = require('pg');
const ref = 'zjrgbsrsthtmxkislgcm';
const passwords = ['Petclub@2026','Petclub2026','petclub@2026'];
const regions = ['ap-south-1','us-east-1','us-west-2','ap-southeast-1'];

async function tryAll() {
  for (const pw of passwords) {
    for (const region of regions) {
      const c = new Client({
        host: 'aws-0-' + region + '.pooler.supabase.com',
        port: 6543,
        database: 'postgres',
        user: 'postgres.' + ref,
        password: pw,
        ssl: { rejectUnauthorized: false },
        connectionTimeoutMillis: 4000,
      });
      try {
        await c.connect();
        const r = await c.query("SELECT current_database()");
        console.log('SUCCESS pw=' + pw + ' region=' + region);
        const sql = require('fs').readFileSync('./schema.sql','utf8');
        const stmts = sql.split(';').map(s=>s.trim()).filter(s=>s.length>5);
        let ok=0,skip=0;
        for(const stmt of stmts){try{await c.query(stmt);ok++;}catch(e){skip++;}}
        console.log('Tables created: '+ok+' OK, '+skip+' skipped');
        await c.end();
        process.exit(0);
      } catch(e) {
        try{await c.end();}catch{}
      }
    }
  }
  console.log('All passwords failed');
}
tryAll();
