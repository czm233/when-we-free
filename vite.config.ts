import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  base: '/when-we-free/',
  plugins: [react()],
  server: {
    host: '127.0.0.1',
    port: 10060,
    strictPort: true,
  },
  preview: {
    host: '127.0.0.1',
    port: 10060,
    strictPort: true,
  },
})
