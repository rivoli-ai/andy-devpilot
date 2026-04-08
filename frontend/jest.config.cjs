/** @type {import('jest').Config} */
module.exports = {
  preset: 'jest-preset-angular',
  setupFilesAfterEnv: ['<rootDir>/setup-jest.ts'],
  testPathIgnorePatterns: ['<rootDir>/node_modules/', '<rootDir>/dist/'],
  modulePathIgnorePatterns: ['<rootDir>/dist/'],
  watchman: false,
  // Allow transforming ESM-heavy deps pulled in by MarkdownPipe / Mermaid (marked, etc.)
  transformIgnorePatterns: [
    'node_modules/(?!(.*\\.mjs$|@angular/common/locales/.*\\.js$|marked/|marked-highlight/|khroma/|mermaid/|prismjs/))',
  ],
};
