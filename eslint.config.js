import js from '@eslint/js';
import globals from 'globals';

export default [
  { ignores: ['node_modules/**', 'package-lock.json', 'data/**'] },
  js.configs.recommended,
  {
    files: ['**/*.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      // server + lib + test run under Node, public/ runs in the browser —
      // the union keeps both happy without per-file globals plumbing.
      globals: { ...globals.node, ...globals.browser },
    },
  },
  {
    // Socket.IO's client script (served at /socket.io/socket.io.js) injects
    // this global before app.js runs — see index.html.
    files: ['public/**/*.js'],
    languageOptions: { globals: { io: 'readonly' } },
  },
];
