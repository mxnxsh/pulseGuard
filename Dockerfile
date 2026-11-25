# PulseGuard production image. One image, two commands:
#   API:    node apps/api/src/server.js
#   Worker: node apps/worker/src/worker.js

# ---- Build stage -------------------------------------------------------------
FROM node:20-alpine AS build

WORKDIR /app
# Install with clean cache-friendly steps.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

# ---- Runtime stage -----------------------------------------------------------
FROM node:20-alpine AS runtime

# Run as non-root for defense in depth.
RUN addgroup -S pulseguard && adduser -S -G pulseguard pulseguard

WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000

# Copy production node_modules and application source.
COPY --from=build /app/node_modules ./node_modules
COPY package.json package-lock.json ./
COPY apps ./apps
COPY database ./database
COPY scripts ./scripts

USER pulseguard
EXPOSE 3000

# Default is the API. Override with `docker run ... npm run worker`.
CMD ["node", "apps/api/src/server.js"]
