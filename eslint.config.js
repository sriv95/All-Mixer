import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  // spike/ holds research benches (SRI-5, SRI-15); nothing in it ships.
  { ignores: ['dist/', 'node_modules/', 'spike/', 'scripts/qa-*', 'scripts/*.bak', '.qa-out/', '.venv/', 'out/'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      globals: { ...globals.browser, ...globals.webextensions, ...globals.node },
    },
  },
  {
    files: ['src/worklet/**'],
    languageOptions: { globals: globals.audioWorklet },
  },
  {
    // Unrolled FFT butterflies reuse temporaries on purpose.
    files: ['src/worklet/dsp/*.js'],
    rules: { 'no-useless-assignment': 'off' },
  },
);
