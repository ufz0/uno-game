FROM node:22-alpine

ENV NODE_ENV=production
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY server.js ./
COPY lib ./lib
COPY public ./public

# Room state persists to /app/data across restarts; the directory must exist
# and be writable by the non-root user (a named volume picks up its
# ownership from here on first use).
RUN mkdir -p /app/data && chown node:node /app/data

EXPOSE 3000
USER node

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s \
  CMD wget -qO- http://127.0.0.1:3000/api/health || exit 1

CMD ["node", "server.js"]
