import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig(({ mode }) => {
  // 載入 .env 文件到 process.env（Vite 預設只注入 import.meta.env）
  const env = loadEnv(mode, process.cwd(), '');

  return {
    plugins: [react()],
    server: {
      port: 5174,
      proxy: {
        '/api': {
          target: env.VITE_API_URL || 'http://localhost:3000',
          changeOrigin: true,
          ws: true // WebSocket proxy
        }
      }
    },
    build: {
      outDir: 'dist',
      sourcemap: false // 🔒 QA-R2: 生產環境不暴露原始碼
    },
    // 不再手動 define — Vite 會自動從 .env 讀取 VITE_ 前綴的變數
    // 並注入到 import.meta.env
  };
});
