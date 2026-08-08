import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/__tests__/**/*.test.ts'],
    // The suite runs in the production-shaped configuration: a real
    // ENCRYPTION_KEY, never the insecure DB-stored fallback. Tests that need
    // the key-absent paths delete this themselves. Setting the fallback opt-in
    // here instead would silently exempt the whole suite from the guard it is
    // supposed to be testing.
    env: {
      ENCRYPTION_KEY: 'f'.repeat(64),
    },
  },
});
