/** @type {import('jest').Config} */
module.exports = {
  testEnvironment: 'node',
  testMatch:       ['**/tests/**/*.test.js'],
  testTimeout:     15000,        // 15 s — allows for async Supabase mock chains
  clearMocks:      true,         // reset all mocks between tests
  verbose:         true,
  // Inject required env vars before any test module loads
  setupFiles:      ['./tests/helpers/setupEnv.js'],
  // Don't transform node_modules
  transformIgnorePatterns: ['/node_modules/'],
  // Coverage (run with --coverage flag)
  collectCoverageFrom: [
    'services/loyaltyService.js',
    'services/revenueService.js',
  ],
  coverageThreshold: {
    global: { lines: 80, functions: 80 },
  },
};
