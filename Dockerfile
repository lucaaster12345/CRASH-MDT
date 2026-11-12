FROM node:24.22.1-bookworm-slim AS build
WORKDIR /opt/mdt
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates openssl && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
RUN npm run build && npm prune --omit=dev --no-audit --no-fund

FROM node:24.22.1-bookworm-slim
WORKDIR /opt/mdt
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates openssl && rm -rf /var/lib/apt/lists/*
COPY --from=build --chown=node:node /opt/mdt/package.json /opt/mdt/package-lock.json ./
COPY --from=build --chown=node:node /opt/mdt/node_modules ./node_modules
COPY --from=build --chown=node:node /opt/mdt/prisma ./prisma
COPY --from=build --chown=node:node /opt/mdt/prisma.config.ts ./
COPY --from=build --chown=node:node /opt/mdt/dist ./dist
USER node
ENV NODE_ENV=production BIND_HOST=0.0.0.0 PORT=3000
EXPOSE 3000
CMD ["node", "--enable-source-maps", "dist/server/apps/server/index.js"]
