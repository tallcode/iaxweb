import type { Plugin } from 'vite'
import { constants, gzipSync } from 'node:zlib'
import tailwindcss from '@tailwindcss/vite'
import vue from '@vitejs/plugin-vue'
import { defineConfig } from 'vite'

function precompressAssets(): Plugin {
  return {
    generateBundle(_, bundle) {
      for (const output of Object.values(bundle)) {
        const source = output.type === 'asset' ? output.source : output.code
        this.emitFile({
          fileName: `${output.fileName}.gz`,
          source: gzipSync(source, { level: constants.Z_BEST_COMPRESSION }),
          type: 'asset',
        })
      }
    },
    name: 'precompress-assets',
  }
}

export default defineConfig({
  build: {
    rollupOptions: {
      output: {
        assetFileNames: asset => asset.name === 'zhejiang.geojson'
          ? 'assets/zhejiang.geojson'
          : 'assets/[name]-[hash][extname]',
      },
    },
  },
  plugins: [vue(), tailwindcss(), precompressAssets()],
  server: {
    proxy: {
      '/api': 'http://localhost:3000',
      '/audio': { target: 'ws://localhost:3000', ws: true },
      '/status': { target: 'ws://localhost:3000', ws: true },
    },
  },
})
