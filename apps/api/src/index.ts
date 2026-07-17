import { createPool } from '@atlas/schema';
import { buildServer } from './server.js';

const pool = createPool();
const app = await buildServer(pool);
const port = Number(process.env.PORT ?? 3000);
await app.listen({ port, host: '0.0.0.0' });
console.log(`atlas api listening on :${port}`);
