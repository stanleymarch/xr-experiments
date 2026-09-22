import {defineConfig} from 'vitest/config';

export default defineConfig({
  test: {
    hookTimeout: 180000,
    testTimeout: 120000,
    environment: 'jsdom',
    server: {
      deps: {
        inline: ['xrblocks', 'three'],
      },
    },
  },
});
