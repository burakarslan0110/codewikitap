import { defineWorkspace } from 'vitest/config';

export default defineWorkspace([
  {
    test: {
      name: 'unit',
      include: ['tests/unit/**/*.test.ts'],
      environment: 'node',
    },
  },
  {
    test: {
      name: 'integration',
      include: ['tests/integration/**/*.test.ts'],
      environment: 'node',
      testTimeout: 60_000,
    },
  },
  {
    test: {
      name: 'audit',
      include: ['tests/audit/**/*.audit.test.ts'],
      environment: 'node',
      testTimeout: 60_000,
    },
  },
]);
