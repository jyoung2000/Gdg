import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '../..');

/**
 * The web client.
 *
 * Workspace packages are consumed as TypeScript source through the same path
 * aliases the root tsconfig declares, so there is no per-package build step and
 * no chance of the app running against a stale copy of the design system.
 */
export default defineConfig({
  root: resolve(root, 'apps/web'),
  plugins: [react()],
  resolve: {
    // The array form with anchored patterns matters: a plain '@meridian/ui'
    // key would also prefix-match '@meridian/ui/styles.css' and rewrite it to
    // a path inside index.ts.
    alias: [
      { find: /^@meridian\/shared$/, replacement: resolve(root, 'packages/shared/src/index.ts') },
      { find: /^@meridian\/ui$/, replacement: resolve(root, 'packages/ui/src/index.ts') },
      { find: /^@meridian\/ui\//, replacement: `${resolve(root, 'packages/ui/src')}/` },
    ],
  },
  server: {
    port: 5173,
    // In development the client and the gateway are separate processes; in
    // production they are the same origin, so nothing here changes the code.
    proxy: {
      '/api': { target: 'http://localhost:4639', changeOrigin: true, ws: true },
      '/v1': { target: 'http://localhost:4639', changeOrigin: true },
      '/anthropic': { target: 'http://localhost:4639', changeOrigin: true },
      '/media': { target: 'http://localhost:4639', changeOrigin: true },
    },
  },
  build: {
    outDir: resolve(root, 'apps/web/dist'),
    emptyOutDir: true,
    sourcemap: true,
    chunkSizeWarningLimit: 1200,
    rollupOptions: {
      output: {
        // The editor and terminal are large and are not needed to paint the
        // shell, so they get their own chunks.
        manualChunks: {
          editor: ['codemirror', '@codemirror/view', '@codemirror/state', '@codemirror/merge'],
          terminal: ['@xterm/xterm', '@xterm/addon-fit'],
        },
      },
    },
  },
});
