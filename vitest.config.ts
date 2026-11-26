import { defineConfig } from 'vitest/config';

export default defineConfig({
  define: { __FIREFOX__: 'false' }, // the Chrome path; the Firefox-only popup parts are tested on their own
  test: {
    environment: 'happy-dom',
    testTimeout: 15_000, // React popup tests exceed 5 s when the machine is oversubscribed
    include: ['src/**/*.test.ts', 'scripts/**/*.test.mjs'],
  },
});
