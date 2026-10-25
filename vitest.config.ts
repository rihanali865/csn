import { defineConfig } from 'vitest/config';
import * as path from 'node:path';

export default defineConfig({
  resolve: {
    alias: {
      '@csn/core': path.resolve(__dirname, 'packages/core/src/index.ts'),
      '@csn/privacy': path.resolve(__dirname, 'packages/privacy/src/index.ts'),
      '@csn/adapters': path.resolve(__dirname, 'packages/adapters/src/index.ts'),
      '@csn/discovery': path.resolve(__dirname, 'packages/discovery/src/index.ts'),
      '@csn/compatibility': path.resolve(__dirname, 'packages/compatibility/src/index.ts'),
      '@csn/policy': path.resolve(__dirname, 'packages/policy/src/index.ts'),
      '@csn/reports': path.resolve(__dirname, 'packages/reports/src/index.ts'),
      '@csn/api': path.resolve(__dirname, 'services/api/src/index.ts'),
      '@csn/master-agent': path.resolve(__dirname, 'services/master-agent/src/index.ts'),
    },
  },
  test: {
    environment: 'node',
    include: [
      'packages/**/test/**/*.test.ts',
      'services/**/test/**/*.test.ts',
      'apps/**/test/**/*.test.ts',
      'tests/**/*.test.ts',
    ],
    // 25s: several suites spawn tiny node subprocesses (exec gating, api smoke) on Windows.
    testTimeout: 25000,
  },
});
