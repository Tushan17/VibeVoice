import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  plugins: [
    tailwindcss(),
    react(),
  ],
  // base './' ensures asset URLs are relative so Electron file:// loads work
  base: './',
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
})
