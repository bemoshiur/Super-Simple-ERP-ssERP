# syntax=docker/dockerfile:1
# ssERP production image: multi-stage, Next.js standalone output, non-root user.

FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

FROM node:22-alpine AS build
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1 \
    SSERP_STANDALONE=1
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# `next build` needs no secrets or database: everything is read at request time.
RUN mkdir -p public && npm run build

# One-shot migration runner for upgrades (no Next.js build): `docker compose --profile migrate run --rm migrate`.
# Applies drizzle/ to DATABASE_URL with the same code as `npm run db:migrate`, then exits.
FROM node:22-alpine AS migrate
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json tsconfig.json tsconfig.base.json ./
COPY drizzle ./drizzle
COPY scripts ./scripts
COPY src ./src
USER node
CMD ["node_modules/.bin/tsx", "scripts/migrate.ts"]

# The last stage is the default target: the app image.
FROM node:22-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    HOSTNAME=0.0.0.0
RUN addgroup -S -g 1001 nodejs && adduser -S -u 1001 -G nodejs nextjs
# Standalone server (includes the traced drizzle/ migrations used by /install), static assets (fonts are bundled here), public/.
COPY --from=build --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=build --chown=nextjs:nodejs /app/.next/static ./.next/static
COPY --from=build --chown=nextjs:nodejs /app/public ./public
USER nextjs
EXPOSE 3000
# Lightweight liveness probe; it never touches the database (use /api/health?db=1 for a DB check).
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -q -O /dev/null http://127.0.0.1:3000/api/health || exit 1
CMD ["node", "server.js"]
