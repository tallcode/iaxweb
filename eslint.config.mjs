import antfu from '@antfu/eslint-config'

export default antfu({
  ignores: ['ai/**'],
  rules: {
    'no-console': 'off',
    'test/no-import-node-test': 'off',
  },
})
