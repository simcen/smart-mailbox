FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production DATA_DIR=/data PORT=3000 TZ=Europe/Zurich
RUN apk add --no-cache tzdata
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund
COPY mailbox-logic.js ./
COPY service ./service
VOLUME /data
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s CMD wget -qO- http://127.0.0.1:3000/health || exit 1
CMD ["node", "service/server.js"]
