import antfu from '@antfu/eslint-config'

export default antfu({
  ignores: ['config/**', 'data/**', 'README.md'],
  formatters: true,
  typescript: true,
  vue: true,
  rules: {
    // Keep the repository's existing line-break style.
    'antfu/reasonable-newline': 'off',
    'no-console': 'off',
    'test/no-import-node-test': 'off',
  },
})
