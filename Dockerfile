FROM node:22-alpine

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=10000 \
    NOVA_DATA_DIR=/data

WORKDIR /app
COPY --chown=node:node package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund
COPY --chown=node:node server.js data-store.js billing.js ./
COPY --chown=node:node public ./public
RUN mkdir -p /data && chown node:node /data
EXPOSE 10000
USER node
CMD ["node", "server.js"]
