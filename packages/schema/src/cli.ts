import { createPool, migrate } from './index.js';

const cmd = process.argv[2];

if (cmd !== 'up') {
  console.error('Usage: node cli.js up   (uses ATLAS_DATABASE_URL)');
  process.exit(1);
}

const pool = createPool();
try {
  const result = await migrate(pool);
  for (const f of result.applied) console.log(`applied  ${f}`);
  for (const f of result.skipped) console.log(`skipped  ${f}`);
  if (result.applied.length === 0) console.log('database up to date');
} finally {
  await pool.end();
}
