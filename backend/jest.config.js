/** 테스트 소스는 루트 test/ 폴더에서 통합 관리한다 (docs/dev/01 §5). */
module.exports = {
  rootDir: '..',
  roots: ['<rootDir>/test/backend'],
  testMatch: ['**/*.spec.ts'],
  testEnvironment: 'node',
  transform: {
    '^.+\\.ts$': [require.resolve('ts-jest'), { tsconfig: '<rootDir>/backend/tsconfig.spec.json' }],
  },
  moduleFileExtensions: ['ts', 'js', 'json'],
  moduleDirectories: ['node_modules', '<rootDir>/backend/node_modules'],
  setupFiles: ['<rootDir>/test/backend/env.js'],
  globalSetup: '<rootDir>/test/backend/global-setup.js',
  testTimeout: 60000,
  maxWorkers: 1,
};
