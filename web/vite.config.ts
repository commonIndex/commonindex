import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { notices } from './notices'

// One address for the whole app. The web server forwards the gateway's paths to
// it, so a browser talks only to this port — as it does in production, where
// nginx forwards the same paths (web/nginx.conf). GATEWAY_PROXY says where the
// gateway is: a local `make dev-gateway` by default, `http://gateway:8000` in
// docker-compose.full.yml.
const target = process.env.GATEWAY_PROXY ?? 'http://localhost:8000'
const proxy = Object.fromEntries(['/api', '/auth', '/events', '/share'].map(path => [path, { target }]))

export default defineConfig({
  plugins: [react(), notices()],
  server: { proxy },
  preview: { proxy },
})
