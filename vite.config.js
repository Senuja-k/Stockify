import { defineConfig } from "vite";
import react from "@vitejs/plugin-react-swc";
import path from "path";

// https://vitejs.dev/config/
export default defineConfig(() => ({
  server: {
    host: "::",
    port: 8082,
    // Allow dev access from ngrok tunnel hostname used during local testing
    // (add any other tunnel hostnames here as needed)
    allowedHosts: [
      'isanomalous-shelia-exasperatedly.ngrok-free.dev',
      'shopify-reports-six.vercel.app',
    ],
  },
  plugins: [react()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
}));
