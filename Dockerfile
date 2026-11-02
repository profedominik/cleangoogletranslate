# CleanTranslate — self-contained image (no npm dependencies, SQLite built into Node).
FROM node:24-alpine

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8080 \
    DATA_DIR=/data

WORKDIR /app
COPY package.json README.md ./
COPY server ./server
COPY public ./public

RUN mkdir -p /data && chown -R node:node /data
USER node

VOLUME ["/data"]
EXPOSE 8080

# /api/health answers with or without BASE_PATH and is never behind BASIC_AUTH.
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:${PORT}/api/health" > /dev/null || exit 1

STOPSIGNAL SIGTERM
CMD ["node", "server/index.js"]
