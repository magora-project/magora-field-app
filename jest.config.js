/** @type {import('jest').Config} */
module.exports = {
  preset: 'jest-expo',
  testPathIgnorePatterns: ['/node_modules/', '<rootDir>/tests/contract/', '<rootDir>/tests/smoke/'],
};
