module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  transform: {
    '^.+\\.tsx?$': 'ts-jest',
  },
  moduleFileExtensions: ['ts', 'tsx', 'js', 'jsx', 'json', 'node'],
  moduleNameMapper: {
    '^obsidian$': '<rootDir>/__mocks__/obsidian.ts',
  },
  setupFiles: ['<rootDir>/__tests__/setup.ts'],
  testRegex: '(/__tests__/.*\\.test)\\.(ts|tsx)$',
  verbose: true,
};
