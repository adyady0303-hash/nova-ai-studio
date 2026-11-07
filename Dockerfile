FROM node:24-alpine

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=10000 \
    NOVA_DATA_DIR=/data

WORKDIR /app
COPY --chown=node:node package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund
COPY --chown=node:node server.js data-store.js provider-status.js billing.js web-tools.js ai-providers.js ai-quality.js creation-prompts.js business-site.js restaurants.js google-auth.js ./
COPY --chown=node:node public ./public
COPY --chown=node:node site/index.html site/privacy.html ./site/
COPY --chown=node:node site/media/nova-publicitate-coperta.png ./site/media/
RUN mkdir -p /data && chown node:node /data
EXPOSE 10000
USER node
CMD ["node", "server.js"]
