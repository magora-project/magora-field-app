// `npm run test:contract`: only tests/contract, against the local stack.
// The base config (jest-expo preset) ignores tests/contract so `npm test` never
// needs the stack. The contract tests run in plain Node instead: the React Native
// preset's module mocks and resolver change how @supabase/supabase-js loads, and
// these tests exercise the network contract, not React Native.

/** @type {import('jest').Config} */
module.exports = {
  testEnvironment: 'node',
  setupFiles: ['<rootDir>/tests/setup-env.ts'],
  testMatch: ['<rootDir>/tests/contract/**/*.contract.test.ts'],
  transform: {
    // Plain TypeScript-to-CommonJS. Not babel-preset-expo: it rewrites
    // process.env.EXPO_PUBLIC_* into an import of expo/virtual/env (an ES module).
    '^.+\\.[jt]sx?$': [
      'babel-jest',
      {
        babelrc: false,
        configFile: false,
        presets: ['@babel/preset-typescript'],
        plugins: ['@babel/plugin-transform-modules-commonjs'],
      },
    ],
  },
  // One stack, one test user: run the suites one at a time.
  maxWorkers: 1,
};
