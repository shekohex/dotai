FROM node:24-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

FROM deps AS verify
COPY server.js tsconfig.json ./
RUN npm run check

FROM node:24-alpine AS runtime
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000 \
    PUBLIC_URL= \
    GLANCE_TTL_MS=1800000 \
    GLANCE_MAX_UPLOAD_BYTES=10485760 \
    GLANCE_SWEEP_INTERVAL_MS=30000 \
    GLANCE_MAX_IMAGES=256 \
    GLANCE_STORAGE_DIR=/dev/shm/glance
WORKDIR /app
USER node
COPY --chown=node:node server.js package.json ./
COPY --chown=node:node public ./public
VOLUME ["/dev/shm/glance"]
EXPOSE 3000
CMD ["node", "server.js"]
