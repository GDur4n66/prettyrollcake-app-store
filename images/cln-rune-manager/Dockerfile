FROM node:22-alpine@sha256:0e1754758c2df4cfa3e68d59e2e1b7374bb7fd9ea6328eaaacf15cc934af8202

WORKDIR /app
COPY package.json VERSION ./
COPY src ./src
COPY public ./public
COPY bin ./bin

# Umbrel では CLN のフォルダ（/root/.lightning）を /cln につなぎ、lightning-rpc を直接呼ぶ。
# CLN は root で動き、ソケットは 0600 なので、このコンテナも root で動かす（compose で user を指定しない）。
# フォルダの持ち主が変えられていてもつなげるよう、compose では特権を DAC_OVERRIDE だけにする
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3630 \
    CLN_RPC_SOCKET=/cln/bitcoin/lightning-rpc \
    DB_PATH=/data/app.db

EXPOSE 3630
CMD ["node", "--disable-warning=ExperimentalWarning", "src/main.js"]
