# ==============================================================================
# Stage 1: Dependencies & Build Stage
# ==============================================================================
FROM node:24-alpine AS builder

WORKDIR /app

# Install dependencies reproducibly from the committed package-lock.json
# (generated and npm ci-verified in CI; the stale bun.lock was removed —
# npm is the single supported package manager).
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

# Copy application source and build frontend assets + verify TypeScript strict mode
COPY . .
RUN npm run lint && npm run build

# Prune devDependencies for lean production image
RUN npm prune --omit=dev

# ==============================================================================
# Stage 2: Production Hardened Non-Root Runtime Stage
# ==============================================================================
FROM node:24-alpine AS runner

WORKDIR /app

# Create non-root system group and user (UID/GID 1001)
RUN addgroup -g 1001 -S nodejs && \
    adduser -S gogo -u 1001 -G nodejs

ENV NODE_ENV=production
ENV PORT=3000

# Copy pruned node_modules, built frontend, and backend TypeScript entrypoint
COPY --from=builder --chown=gogo:nodejs /app/node_modules ./node_modules
COPY --from=builder --chown=gogo:nodejs /app/dist ./dist
COPY --from=builder --chown=gogo:nodejs /app/package.json ./package.json
COPY --from=builder --chown=gogo:nodejs /app/server.ts ./server.ts
COPY --from=builder --chown=gogo:nodejs /app/src ./src
COPY --from=builder --chown=gogo:nodejs /app/migrations ./migrations
COPY --from=builder --chown=gogo:nodejs /app/firestore.rules ./firestore.rules
COPY --from=builder --chown=gogo:nodejs /app/firestore.rules.test.ts ./firestore.rules.test.ts
COPY --from=builder --chown=gogo:nodejs /app/firebase-applet-config.json ./firebase-applet-config.json

# Switch to non-root user
USER gogo

EXPOSE 3000

# Container healthcheck probing the readiness endpoint (HTTP + PostgreSQL
# connectivity). Liveness (/api/v1/health/live) stays process-only so a brief
# database outage does not kill a healthy instance.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:3000/api/v1/health/ready || exit 1

CMD ["node", "--import", "tsx", "server.ts"]
