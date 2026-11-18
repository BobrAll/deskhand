const tseslint = require('typescript-eslint')
const reactHooks = require('eslint-plugin-react-hooks')

// Two layers, one config.
//
// The base is `typescript-eslint`'s recommended set: everything that can be
// answered from syntax alone. On top of it sit the rules that need the
// compiler's type information, because they answer questions syntax cannot:
// whether a promise was awaited and whether an async handler fits a void slot.
// Those rules are why this config builds a program at all, and they cost a few
// seconds per run — that is the price of `npm run lint`, not the formatter's.
//
// The React plugin contributes two rules, not its full `recommended` set. The
// compiler-driven rules in that set (`set-state-in-effect`, `refs`, …) describe
// a different rendering model than the one this card is written for, and
// adopting them is a behaviour change, not a lint fix. The two below catch
// missed dependencies and conditional hooks without changing what renders.
//
// Prettier owns layout. `typescript-eslint`'s recommended set contains no
// stylistic rules, so the two do not fight and no `eslint-config-prettier`
// bridge is needed.
module.exports = tseslint.config({
  files: ['src/**/*.{ts,tsx}'],
  extends: [tseslint.configs.recommended],
  plugins: { 'react-hooks': reactHooks },
  languageOptions: {
    parserOptions: {
      // The renderer and the main process have separate programs; a file is
      // checked against the first one that includes it.
      project: ['./tsconfig.node.json', './tsconfig.web.json'],
      tsconfigRootDir: __dirname
    }
  },
  rules: {
    '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],

    // An unawaited promise in `bootstrap` or a lookup queue loses its rejection
    // silently. Where dropping the promise is intended, the call says `void`.
    '@typescript-eslint/no-floating-promises': 'error',

    // `onClick={async () => …}` puts a rejected promise where nothing reads it,
    // and React cannot cancel the work when the element unmounts.
    '@typescript-eslint/no-misused-promises': 'error',

    'react-hooks/rules-of-hooks': 'error',
    'react-hooks/exhaustive-deps': 'error'
  }
})
