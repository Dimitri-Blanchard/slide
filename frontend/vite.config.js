import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import basicSsl from '@vitejs/plugin-basic-ssl';
import removeConsole from 'vite-plugin-remove-console';

const isNativeBuild = process.env.VITE_ELECTRON || process.env.VITE_CAPACITOR;
const isElectronBuild = !!process.env.VITE_ELECTRON;

export default defineConfig({
  base: isNativeBuild ? './' : '/',
  plugins: [
    react(),
    // basicSsl: only needed for the HTTPS dev server (Electron dev connects to https://localhost:5173)
    // Has no effect during builds, but limit to non-Electron builds for clarity
    !isElectronBuild && basicSsl(),
    // Strip console.log/debug/info in production web/capacitor builds only.
    // Electron builds keep minify:false for full React error messages, so don't strip console either.
    !isElectronBuild && removeConsole({ includes: ['log', 'debug', 'info'] }),
  ].filter(Boolean),
  resolve: {
    // Force single React instance — fixes "dispatcher is null" when multiple copies load
    dedupe: ['react', 'react-dom', 'react/jsx-runtime'],
  },
  server: {
    port: 5173,
    strictPort: true, // fail if 5173 is in use (close other Vite/Electron instances first)
    host: '0.0.0.0',
    https: true,
    proxy: {
      '/api': { target: 'http://192.168.1.176:3000', changeOrigin: true },
      '/socket.io': { target: 'http://192.168.1.176:3000', ws: true },
      '/avatars': { target: 'http://192.168.1.176:3000', changeOrigin: true },
      '/uploads': { target: 'http://192.168.1.176:3000', changeOrigin: true },
    },
  },
  // ═══════════════════════════════════════════════════════════
  // PERFORMANCE: Build optimizations
  // ═══════════════════════════════════════════════════════════
  build: {
    // One CSS bundle — avoids Vite runtime "Unable to preload CSS" for lazy routes when
    // /assets/*.css is missing (partial deploy) or index.html is cached with stale hashes.
    cssCodeSplit: false,
    // Smaller chunks for better caching
    chunkSizeWarningLimit: 500,
    rollupOptions: {
      output: {
        // Manual chunk splitting for better caching
        manualChunks: {
          'react-vendor': ['react', 'react-dom', 'react-router-dom'],
          'socket-vendor': ['socket.io-client'],
        },
      },
    },
    // Disable minification for Electron to get full React error messages
    minify: isElectronBuild ? false : 'terser',
    terserOptions: {
      compress: {
        drop_debugger: true,
        // Strip debug console in production (keep warn/error for troubleshooting)
        drop_console: ['log', 'debug', 'info'],
      },
    },
    // Generate source maps for debugging (optional, disable for smaller builds)
    sourcemap: false,
  },
  // Optimize dependencies (pre-bundle to avoid dynamic import failures)
  optimizeDeps: {
    include: ['react', 'react-dom', 'react-router-dom', 'socket.io-client', 'canvas-confetti'],
  },
});
