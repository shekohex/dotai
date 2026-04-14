FROM node:22-alpine

ARG EXECUTOR_VERSION=latest

ENV EXECUTOR_PORT=4788
ENV EXECUTOR_DATA_DIR=/var/lib/executor
ENV EXECUTOR_SCOPE_DIR=/workspace

RUN apk add --no-cache caddy
RUN npm install -g "executor@${EXECUTOR_VERSION}"
RUN executor --help >/dev/null

WORKDIR /workspace

COPY Caddyfile /etc/caddy/Caddyfile
COPY start.sh /usr/local/bin/start-executor-proxy

RUN chmod +x /usr/local/bin/start-executor-proxy

RUN mkdir -p /var/lib/executor /workspace

VOLUME ["/var/lib/executor", "/workspace"]

EXPOSE 80

ENTRYPOINT ["/usr/local/bin/start-executor-proxy"]
