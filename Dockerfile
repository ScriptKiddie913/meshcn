FROM node:22-bookworm-slim

RUN apt-get update && \
    apt-get install -y --no-install-recommends tor ca-certificates && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY . .

COPY docker/torrc /etc/tor/torrc
COPY docker/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

ENV NODE_ENV=production
ENV API_BIND=127.0.0.1:3001

CMD ["/entrypoint.sh"]
