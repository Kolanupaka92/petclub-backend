# ---- Build stage ----
FROM node:22.12.0-alpine3.21 AS deps
WORKDIR /app
COPY package*.json ./
RUN npm ci --only=production

# ---- Runtime stage ----
FROM node:22.12.0-alpine3.21
WORKDIR /app

# Non-root user for security
RUN addgroup -S petclub && adduser -S petclub -G petclub

COPY --from=deps /app/node_modules ./node_modules
# .env files are excluded via .dockerignore — secrets come in at runtime
# via Cloud Run env vars or GCP Secret Manager mounts, never baked into layers.
COPY . .

USER petclub

# Cloud Run injects PORT env var (default 8080)
ENV PORT=8080
EXPOSE 8080

CMD ["node", "server.js"]
