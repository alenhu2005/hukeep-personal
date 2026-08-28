import { defineConfig } from 'vite';

export default defineConfig({
  base: '/hukeep-personal/',
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
});
