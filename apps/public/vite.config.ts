import tailwindcss from '@tailwindcss/vite'
import vue from '@vitejs/plugin-vue'
import { defineConfig } from 'vite'

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
  plugins: [vue(), tailwindcss()],
  server: {
    proxy: {
      '/api': 'http://localhost:3000',
      '/audio': { target: 'ws://localhost:3000', ws: true },
      '/status': { target: 'ws://localhost:3000', ws: true },
    },
  },
})
