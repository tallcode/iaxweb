# syntax=docker/dockerfile:1

# ---- deps: production dependencies only (drops eslint/typescript/types) ----
FROM node:24-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# ---- runtime ----
FROM node:24-alpine AS runtime
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000
WORKDIR /app

# tini gives us a real init so SIGTERM reaches Node and triggers graceful shutdown.
RUN apk add --no-cache tini

COPY --from=deps /app/node_modules ./node_modules
COPY package.json tsconfig.json ./
COPY src ./src
COPY public ./public

# Run unprivileged (the node image ships a "node" user).
USER node

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD wget -q -O - "http://127.0.0.1:${PORT:-3000}/healthz" >/dev/null 2>&1 || exit 1

ENTRYPOINT ["/sbin/tini", "--"]
# tsx runs the TypeScript source in-process via Node's loader (no child fork),
# so Node stays PID 1 under tini and the SIGINT/SIGTERM handlers fire.
CMD ["node", "--import", "tsx", "src/server.ts"]
