import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// Each view is one module, which the platform inlines into the document it
// frames the view in. That document maps the MCP Apps SDK to the platform's own
// copy and loads the kit's style sheet and icon font, so the build leaves the
// SDK as an import and bundles the rest, its own styles included.
const ENTRIES: Record<string, { input: string; file: string }> = {
  hud: { input: 'src/hud/index.ts', file: 'hud.js' },
  micTest: { input: 'src/view/micTest.tsx', file: 'mic-test.js' },
  history: { input: 'src/view/index.tsx', file: 'history.js' },
};

export default defineConfig(({ mode }) => ({
  plugins: [react()],
  define: { 'process.env.NODE_ENV': '"production"' },
  build: {
    outDir: 'views',
    emptyOutDir: false,
    target: 'es2022',
    modulePreload: false,
    rollupOptions: {
      input: ENTRIES[mode]!.input,
      external: ['@modelcontextprotocol/ext-apps'],
      output: {
        format: 'es',
        inlineDynamicImports: true,
        entryFileNames: ENTRIES[mode]!.file,
      },
    },
  },
}));
