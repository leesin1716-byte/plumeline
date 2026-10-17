// Plumeline 웹 데모 빌드 설정: 어느 경로에 올려도 동작하도록 상대 경로로 빌드한다
import { defineConfig } from "vite";

export default defineConfig({
  base: "./",
  build: { outDir: "dist", target: "es2022", chunkSizeWarningLimit: 4000 },
  server: { port: 5199, strictPort: true },
});
