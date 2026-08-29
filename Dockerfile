# Web Zotero — production container
# Build:  docker build -t web-zotero .
# Run:    docker run -d --name web-zotero \
#           -p 8420:8420 \
#           -v /path/to/Zotero:/zotero:ro \
#           -v web-zotero-data:/app/data \
#           -e WEB_PASSWORD=change-me \
#           web-zotero
#
# The Zotero data directory is mounted read-only; the server never writes
# to it. Web-layer data (notes, annotations, users) lives in the named
# volume mounted at /app/data.

FROM node:22-alpine AS base

# tini reaps zombies and forwards signals so `docker stop` is clean.
RUN apk add --no-cache tini

WORKDIR /app

# Dependencies first for layer caching.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# Application source + prebuilt public bundles.
COPY src/ src/
COPY public/ public/
COPY csl-styles/ csl-styles/
COPY db/ db/

# Non-root user; /app/data must be writable for the SQLite stores.
RUN addgroup -S wz && adduser -S wz -G wz \
    && mkdir -p /app/data && chown -R wz:wz /app/data
USER wz

ENV NODE_ENV=production \
    PORT=8420 \
    HOST=0.0.0.0 \
    DATA_DIR=/app/data

EXPOSE 8420

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:8420/api/health', r => process.exit(r.statusCode === 200 ? 0 : 1)).on('error', () => process.exit(1))"

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "src/server.js"]
