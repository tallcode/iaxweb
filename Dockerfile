# syntax=docker/dockerfile:1

# sherpa-onnx's prebuilt Linux addon requires glibc.
FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/backend/package.json apps/backend/package.json
COPY apps/admin/package.json apps/admin/package.json
COPY apps/public/package.json apps/public/package.json
COPY packages/audio-protocol/package.json packages/audio-protocol/package.json
COPY packages/contracts/package.json packages/contracts/package.json
RUN npm ci
COPY apps/admin apps/admin
COPY apps/public apps/public
COPY packages/audio-protocol packages/audio-protocol
COPY packages/contracts packages/contracts
COPY tsconfig.json ./
RUN npm run build

FROM node:24-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/backend/package.json apps/backend/package.json
COPY apps/admin/package.json apps/admin/package.json
COPY apps/public/package.json apps/public/package.json
COPY packages/audio-protocol/package.json packages/audio-protocol/package.json
COPY packages/contracts/package.json packages/contracts/package.json
RUN npm ci --omit=dev

FROM node:24-bookworm-slim AS runtime
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000 \
    LD_LIBRARY_PATH=/app/node_modules/sherpa-onnx-linux-x64:/app/node_modules/sherpa-onnx-linux-arm64 \
    ALLMON3_BASE_URL=http://172.16.211.199/allmon3/
WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends tini libgomp1 ca-certificates \
  && rm -rf /var/lib/apt/lists/* \
  && mkdir -p /app/config /app/data \
  && chown node:node /app/config /app/data

COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/apps ./apps
COPY --from=deps /app/packages ./packages
COPY package.json tsconfig.json LICENSE ./
COPY packages/audio-protocol packages/audio-protocol
COPY packages/contracts packages/contracts
COPY apps/backend/src apps/backend/src
COPY apps/backend/scripts apps/backend/scripts
COPY --from=build /app/apps/admin/dist apps/admin/dist
COPY --from=build /app/apps/public/dist apps/public/dist

# Check imports from the final production dependency layout before publishing.
RUN node --import tsx --input-type=module -e \
  "import './apps/backend/src/ai/schema-validator.ts'; import './apps/backend/src/ai/segment-audio.ts'"

USER node
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || 3000) + '/healthz', { signal: AbortSignal.timeout(2500) }).then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "--import", "tsx", "apps/backend/src/server.ts"]
