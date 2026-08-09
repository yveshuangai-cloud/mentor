FROM node:22-slim

# MiniMax returns MP3; ffmpeg converts audio for LINE delivery.
RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy manifests first to preserve the dependency cache.
COPY package.json package-lock.json ./
COPY packages/backend/package.json packages/backend/
COPY packages/voice-call/frontend/package.json packages/voice-call/frontend/
RUN npm ci --workspace packages/backend --include-workspace-root=false

COPY packages/backend packages/backend
COPY soul soul

RUN npm run soul:lint -w packages/backend \
  && npm run typecheck -w packages/backend \
  && DATABASE_URL=postgresql://test:test@127.0.0.1:5432/test npm test -w packages/backend \
  && npm run build -w packages/backend \
  && cp packages/backend/src/db/*.sql packages/backend/dist/db/ \
  && { [ -d packages/backend/src/db/migrations ] && cp -r packages/backend/src/db/migrations packages/backend/dist/db/ || true; } \
  && npm prune --omit=dev --workspace packages/backend --include-workspace-root=false

ENV NODE_ENV=production
EXPOSE 3000
CMD ["node", "packages/backend/dist/index.js"]
