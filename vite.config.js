import { defineConfig } from 'vite';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const version = process.env.VITE_APP_VERSION || execFileSync('git', ['rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim();
const builtAt = new Date().toISOString();

export default defineConfig({
  base: '/hukeep-personal/',
  define: { 'import.meta.env.VITE_APP_VERSION': JSON.stringify(version) },
  plugins: [{ name: 'app-version', generateBundle(_options, bundle) {
    const assets = Object.keys(bundle).filter(name => /\.(js|css)$/.test(name));
    const worker = readFileSync(new URL('./public/sw.js', import.meta.url), 'utf8')
      .replace('shell-v3', 'shell-' + assets.join('-'))
      .replace('/* built assets */', assets.map(name => JSON.stringify('./' + name)).join(', '));
    this.emitFile({ type: 'asset', fileName: 'sw.js', source: worker });
    this.emitFile({ type: 'asset', fileName: 'version.json', source: JSON.stringify({ version, builtAt }) });
  } }],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
});
