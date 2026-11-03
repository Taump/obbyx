import { defineProject } from 'vitest/config';

export default defineProject({
  resolve: { conditions: ['@obbyx/source'] },
  ssr: { resolve: { conditions: ['@obbyx/source'] } },
  test: {
    name: '@obbyx/facilitator',
    include: ['test/**/*.test.ts'],
  },
});
