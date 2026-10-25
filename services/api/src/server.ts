import * as path from 'node:path';
import * as os from 'node:os';
import { createApiApp } from './app.js';
import { FileStore } from './store.js';

/**
 * Standalone entry: `npm run api` (tsx services/api/src/server.ts).
 * Defaults bind to 127.0.0.1 only — a public deployment is an ops decision,
 * not a convenience default.
 */
const port = Number(process.env.CSN_API_PORT ?? 8787);
const host = process.env.CSN_API_HOST ?? '127.0.0.1';
const dataFile = process.env.CSN_API_DATA ?? path.join(os.homedir(), '.config', 'csn', 'api', 'data.json');

const store = new FileStore(dataFile);
const app = createApiApp({ store });

const server = app.listen(port, host, () => {
  console.log(`[csn-api] listening on http://${host}:${port} (store: ${dataFile})`);
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1500).unref();
  });
}
