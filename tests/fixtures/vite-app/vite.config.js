import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Minimal Vite config for the PR 1.14 HMR smoke test.
//
// The test mounts ReverseProxyService on its own port and proxies
// `<slug>.localhost:<proxyPort>` → this Vite. The framework binds at /
// (subdomain mode does not require --base) and the proxy preserves Host.
//
// `allowedHosts` includes `.localhost` so Vite ≥4.5 doesn't reject the
// X-Forwarded-Host coming through the proxy. `server.hmr.clientPort`
// (read from VITE_HMR_CLIENT_PORT) lets the test pin the port the
// HMR client connects to — important if the browser's idea of the page
// origin differs from the request port the framework received. Defaults
// to undefined, meaning "use the same port the request came from."
export default defineConfig({
  plugins: [react()],
  server: {
    host: '127.0.0.1',
    strictPort: true,
    allowedHosts: ['.localhost'],
    hmr: process.env.VITE_HMR_CLIENT_PORT
      ? { clientPort: Number(process.env.VITE_HMR_CLIENT_PORT) }
      : true,
  },
});
