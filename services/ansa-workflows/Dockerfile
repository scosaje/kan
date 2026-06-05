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
COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
COPY agents ./agents
RUN chown -R node:node /app
USER node
CMD ["node", "dist/worker.js"]
