import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  // Tests may read the type declarations in ../types, so the editor can be
  // checked against the schema the gateway enforces rather than a copy of it.
  // This config is only ever used by vitest; the dev server's is vite.config.
  server: { fs: { allow: ['..'] } },
  test: {
    environment: 'jsdom',
    globals: true,
    // The gateway is mocked at `fetch`, so the real client runs: its headers,
    // its error typing, its payload serialisation. Mocking the client module
    // instead would test the test.
    //
    // The setup file fills in what jsdom lacks — ResizeObserver and a non-zero
    // bounding box — because a chart mounting without them throws from a ref
    // callback and the failure surfaces as a missing element elsewhere.
    setupFiles: ['./vitest.setup.ts'],
  },
})
