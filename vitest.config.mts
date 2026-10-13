import { defineConfig } from 'vitest/config';

// Backend tests run under Electron's own Node (see the "test" script), so the
// native better-sqlite3 build matches the ABI the app actually ships with.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['electron/**/*.test.ts', 'src/**/*.test.ts'],
    // Real filesystem + SQLite work; run files one after another for stable temp dirs.
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
    testTimeout: 20000,
    hookTimeout: 20000,
  },
});
