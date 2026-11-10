FROM node:22-alpine@sha256:0e1754758c2df4cfa3e68d59e2e1b7374bb7fd9ea6328eaaacf15cc934af8202

WORKDIR /app
COPY package.json VERSION ./
COPY src ./src
COPY public ./public
COPY bin ./bin

# Umbrel では LND のフォルダを /lnd に読み取り専用でつなぐ
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3620 \
    LND_DIR=/lnd \
    DB_PATH=/data/app.db

USER 1000:1000
EXPOSE 3620
CMD ["node", "--disable-warning=ExperimentalWarning", "src/main.js"]
