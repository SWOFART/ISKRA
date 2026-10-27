import { defineConfig } from 'vite';

export default defineConfig({
  // Google-sourced VITE_* process values are the only build configuration source.
  envDir: false,
  build: { outDir: 'dist/client' },
});
