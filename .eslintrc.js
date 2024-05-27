module.exports = {
  root: true,
  extends: [
    'prettier',
  ],
  parser: '@typescript-eslint/parser',
  plugins: [
    '@typescript-eslint',
    'simple-import-sort',
  ],
  rules: {
    'prettier/prettier': 0,
    'simple-import-sort/imports': [
      'warn',
      {
        groups: [
          ['^\\u0000'],
          ['^node:'],
          [
            '^(?:$|\\/)@?\\w',
          ],
          ['^'],
        ],
      },
    ],
    'simple-import-sort/exports': 'warn',
  },
  settings: {
    componentWrapperFunctions: ['observer'],
  },
  parserOptions: {
    sourceType: 'module',
    ecmaVersion: 'latest',
  },
}
