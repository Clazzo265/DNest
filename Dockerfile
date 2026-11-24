# DataNest — single-container deployment (frontend + API + storage)
FROM node:22-slim AS build

WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci --no-audit --no-fund || npm install --no-audit --no-fund

COPY tsconfig.json vite.config.ts index.html postcss.config.js tailwind.config.js ./
COPY src ./src
COPY backend ./backend
COPY server ./server
RUN npm run build:web

FROM node:22-slim AS runtime

ENV NODE_ENV=production \
    PORT=8080 \
    DATANEST_DATA_DIR=/data \
    DATANEST_STATIC_DIR=/app/dist

WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev --no-audit --no-fund || npm install --omit=dev --no-audit --no-fund

COPY --from=build /app/dist ./dist
COPY src ./src
COPY backend ./backend
COPY server ./server
COPY tsconfig.json ./

# Vault data must survive container replacement.
RUN mkdir -p /data && chown -R node:node /data
USER node
VOLUME ["/data"]

EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=4s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "--import", "tsx", "--import", "./server/register.ts", "server/index.ts"]
