# syntax=docker/dockerfile:1

FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/backend/package.json apps/backend/package.json
COPY apps/frontend/package.json apps/frontend/package.json
COPY packages/contracts/package.json packages/contracts/package.json
RUN npm ci
COPY apps/frontend apps/frontend
COPY packages/contracts packages/contracts
COPY tsconfig.json ./
RUN npm run build

FROM node:24-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/backend/package.json apps/backend/package.json
COPY apps/frontend/package.json apps/frontend/package.json
COPY packages/contracts/package.json packages/contracts/package.json
RUN npm ci --omit=dev

FROM node:24-alpine AS runtime
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000 \
    ALLMON3_BASE_URL=http://172.16.211.199/allmon3/
WORKDIR /app

RUN apk add --no-cache tini \
  && mkdir -p /app/config /app/data \
  && chown node:node /app/config /app/data

COPY --from=deps /app/node_modules ./node_modules
COPY package.json tsconfig.json ./
COPY apps/backend/package.json apps/backend/package.json
COPY packages/contracts packages/contracts
COPY apps/backend/src apps/backend/src
COPY --from=build /app/apps/frontend/dist apps/frontend/dist
COPY nodes.json ./

USER node
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD wget -q -O - "http://127.0.0.1:${PORT:-3000}/healthz" >/dev/null 2>&1 || exit 1

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "--import", "tsx", "apps/backend/src/server.ts"]
