import 'dotenv/config';
import { initDb } from './db.js';
import { syncAll } from './sync.js';

initDb();
const results = await syncAll();
console.log(JSON.stringify(results, null, 2));
process.exit(results.some((r) => !r.ok) ? 1 : 0);
