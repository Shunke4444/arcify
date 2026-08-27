// Same output as `npm run dev`, but a single build that exits.
//
// vite.config.dev.js sets build.watch, so it never returns - and killing it mid-rebuild
// leaves dist-dev empty, because emptyOutDir wipes the directory before writing. Use this
// when you just want the dev build refreshed once.
import { defineConfig } from 'vite';
import { createArcifyConfig } from './vite-plugins/vite-plugin-arcify-extension.js';

const config = createArcifyConfig({ isDev: true });
delete config.build.watch;

export default defineConfig(config);
