import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'happy-dom',
    testTimeout: 15_000, // React popup tests exceed 5 s when the machine is oversubscribed
    include: ['src/**/*.test.ts', 'scripts/**/*.test.mjs'],
  },
});
