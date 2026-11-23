/** @type {import('jest').Config} */
module.exports = {
  preset: 'jest-expo',
  setupFiles: ['<rootDir>/tests/setup-env.ts'],
  testPathIgnorePatterns: ['/node_modules/', '<rootDir>/tests/contract/', '<rootDir>/tests/smoke/'],
};
