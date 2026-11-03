import { defineConfig } from 'vitest/config';

export default defineConfig({
  // Resolve workspace packages to their TypeScript sources (no build needed in dev/tests).
  resolve: { conditions: ['@obbyx/source'] },
  ssr: { resolve: { conditions: ['@obbyx/source'] } },
  test: {
    projects: ['packages/*', 'apps/*'],
  },
});
