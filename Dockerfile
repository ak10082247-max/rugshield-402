# Build Stage
FROM node:22-alpine AS builder
WORKDIR /app

COPY package*.json tsconfig.json ./
RUN npm ci --no-audit --no-fund

COPY src ./src
COPY public ./public
RUN npm run build && npm prune --omit=dev

# Production Stage
FROM node:22-alpine
WORKDIR /app

ENV NODE_ENV=production
ENV PORT=4020

COPY --from=builder /app/package.json ./
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/public ./public

# Run as non-root user
USER node

EXPOSE 4020

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD wget -qO- http://127.0.0.1:${PORT}/health || exit 1

CMD ["node", "dist/index.js"]
