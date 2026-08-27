import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: Number(process.env.VITE_PORT ?? 5173),
    proxy: { '/api': process.env.VITE_API_TARGET ?? 'http://localhost:3001' },
  },
})
