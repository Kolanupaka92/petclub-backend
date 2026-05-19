# ---- Build stage ----
FROM node:22-alpine AS deps
WORKDIR /app
COPY package*.json ./
RUN npm ci --only=production

# ---- Runtime stage ----
FROM node:22-alpine
WORKDIR /app

# Non-root user for security
RUN addgroup -S petclub && adduser -S petclub -G petclub

COPY --from=deps /app/node_modules ./node_modules
COPY . .

# Remove dev files
RUN rm -f .env .env.*

USER petclub

# Cloud Run injects PORT env var (default 8080)
ENV PORT=8080
EXPOSE 8080

CMD ["node", "server.js"]
