FROM node:20-bookworm-slim AS deps
WORKDIR /app
COPY package.json ./
RUN npm install --omit=optional --no-audit --no-fund

FROM node:20-bookworm-slim AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json tsconfig.json ./
COPY src ./src
RUN ./node_modules/.bin/tsc -p tsconfig.json

FROM node:20-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production
RUN apt-get update && apt-get install -y --no-install-recommends curl \
    && rm -rf /var/lib/apt/lists/*
COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
COPY policies ./policies
RUN chown -R node:node /app
USER node
EXPOSE 8090
HEALTHCHECK --interval=30s --timeout=4s --start-period=15s --retries=3 \
  CMD curl -fsS http://127.0.0.1:8090/healthz || exit 1
CMD ["node", "dist/index.js"]
