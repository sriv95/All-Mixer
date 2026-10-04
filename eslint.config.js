import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  // spike/ holds throwaway prototypes; production code lives under src/.
  { ignores: ['dist/', 'node_modules/', 'spike/'] },
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
);
