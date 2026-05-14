# syntax=docker/dockerfile:1.6
# ── Build stage ───────────────────────────────────────────────────────────────
FROM node:20-slim AS builder
WORKDIR /app

# Sharp on Debian-slim needs build essentials only if no prebuilt wheel — npm
# usually picks the prebuilt linux-musl/glibc binary so we don't install them.
COPY package.json package-lock.json* ./
RUN npm ci --no-audit --no-fund

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# Drop dev deps for the runtime image.
RUN npm prune --omit=dev

# ── Runtime stage ─────────────────────────────────────────────────────────────
FROM node:20-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
# Cloud Run sets PORT; the Hono server already reads it.
EXPOSE 8080

COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY package.json ./

# Run as non-root for the usual safety reasons.
USER node

# We don't pass --env-file here; Cloud Run injects env vars and Secret Manager
# secrets directly into process.env, so `node dist/index.js` is enough.
CMD ["node", "dist/index.js"]
