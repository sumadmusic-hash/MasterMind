import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  build: {
    // Größere Chunks vorab komprimieren (gzip/br) – schnellere Auslieferung
    reportCompressedSize: true,
    rollupOptions: {
      output: {
        // Stabile Vendor-Chunks: Framework-Code wird separat gecacht, damit
        // eigener App-Code die großen Bibliotheken nicht mit invalidiert.
        manualChunks(id) {
          if (!id.includes('node_modules')) return;
          if (id.includes('@xyflow') || id.includes('reactflow')) return 'vendor-flow';
          if (id.includes('framer-motion')) return 'vendor-motion';
          if (id.includes('recharts') || id.includes('d3-')) return 'vendor-charts';
          if (id.includes('lucide-react')) return 'vendor-icons';
          if (id.includes('@supabase')) return 'vendor-supabase';
          if (id.includes('dexie')) return 'vendor-dexie';
          // React-Kern + Router: muss VOR dem generischen vendor-Fallback
          // liegen, damit react/react-dom nicht in "vendor" landet und es zu
          // zirkulären Chunk-Importen (vendor -> vendor-react -> vendor) kommt.
          if (/[\\/](react|react-dom|scheduler|react-router|react-router-dom)[\\/]/.test(id)) return 'vendor-react';
          return 'vendor';
        },
      },
    },
  },
  server: {
    host: "0.0.0.0",
    // Standard Vite-Port (5173): Der Preview-/Proxy-Layer der Plattform stellt
    // die App unter http://localhost:5173 bereit. Ein hart erzwungener
    // anderer Port (früher 3000 mit strictPort) führte dazu, dass Requests
    // auf 5173 von einem statischen Fallback bedient wurden, der JS-Module
    // mit MIME-Type "text/html" auslieferte -> weißer Bildschirm.
    port: 5173,
    strictPort: true,
    // HMR-WebSocket an denselben Port wie den Dev-Server binden, damit er
    // auch hinter Proxys funktioniert und nicht stumm auf Port 3000 zeigt.
    hmr: {
      port: 5173,
    },
    proxy: {
      // Webz.io News API (https://app.webz.io/): api.webz.io sendet keine
      // CORS-Headers, daher laufen die Browser-Fetches des webz_news-Tools
      // über diesen Dev-Proxy. Pfad wird entfernt (/webz-api/search →
      // https://api.webz.io/search). In Produktion durch eine eigene
      // Proxy-Basis in den Settings (webzApiBaseUrl) ersetzen.
      '/webz-api': {
        target: 'https://api.webz.io',
        changeOrigin: true,
        secure: true,
        rewrite: (path) => path.replace(/^\/webz-api/, ''),
      },
    },
  },
});
