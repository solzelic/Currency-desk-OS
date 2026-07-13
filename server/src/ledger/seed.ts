import pg from "pg";
if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required for ledger seed data.");
const pool=new pg.Pool({connectionString:process.env.DATABASE_URL});const scope=["tnt-yorkfx","le-yorkfx-canada","br-yorkville","ws-yorkville-till-01","till-01"];
await pool.query("INSERT INTO ledger_principals VALUES ('tnt-yorkfx:a.singh',$1,$2,$3,$4,$5,'teller','[\"br-yorkville\"]'),('tnt-yorkfx:r.haddad',$1,$2,$3,$4,$5,'branch_manager','[\"br-yorkville\"]') ON CONFLICT DO NOTHING",scope);
await pool.query("INSERT INTO ledger_customers VALUES ('customer-demo',$1,$2,$3,$4,'Demo Customer','Normal','verified') ON CONFLICT DO NOTHING",scope.slice(0,4));
await pool.query("INSERT INTO ledger_rates VALUES ($1,$2,$3,$4,'CAD',1),($1,$2,$3,$4,'USD',0.731),($1,$2,$3,$4,'EUR',0.676),($1,$2,$3,$4,'GBP',0.581) ON CONFLICT DO NOTHING",scope.slice(0,4));
for(const [currency,value] of [["CAD",25000],["USD",12000],["EUR",7000],["GBP",3500]])await pool.query("INSERT INTO ledger_till_balances VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING",[...scope,currency,value]);
await pool.end();console.log("ledger seed applied");
