import { defineConfig } from 'vite';
import { execFileSync } from 'node:child_process';

const version = process.env.VITE_APP_VERSION || execFileSync('git', ['rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim();
const builtAt = new Date().toISOString();

export default defineConfig({
  base: '/hukeep-personal/',
  define: { 'import.meta.env.VITE_APP_VERSION': JSON.stringify(version) },
  plugins: [{ name: 'app-version', generateBundle() {
    this.emitFile({ type: 'asset', fileName: 'version.json', source: JSON.stringify({ version, builtAt }) });
  } }],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
});
