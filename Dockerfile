# mantou-platform backend（monorepo：從 repo root build）
FROM node:22-slim

# ffmpeg：MiniMax mp3 → LINE audio 訊息要的 m4a
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# 先裝依賴（利用 layer cache）
COPY package.json package-lock.json ./
COPY packages/backend/package.json packages/backend/
RUN npm ci

# 源碼＋靈魂檔（loader 從 repo root 找 soul/）
COPY packages/backend packages/backend
COPY soul soul

# build；tsc 不帶 .sql，手動補進 dist（db/index.ts 用 __dirname 讀）
RUN npm run build -w packages/backend \
  && cp packages/backend/src/db/*.sql packages/backend/dist/db/ \
  && { [ -d packages/backend/src/db/migrations ] && cp -r packages/backend/src/db/migrations packages/backend/dist/db/ || true; } \
  && npm prune --omit=dev

ENV NODE_ENV=production
EXPOSE 3000
CMD ["node", "packages/backend/dist/index.js"]
