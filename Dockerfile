# BUILD
FROM node:22-alpine as builder

WORKDIR /opt/src

RUN apk add --no-cache bash git python3 perl alpine-sdk

COPY fluxcd-notifications-otel-adapter-server fluxcd-notifications-otel-adapter-server

RUN cd fluxcd-notifications-otel-adapter-server && \
    npm ci && \
    npm run build

COPY fluxcd-notifications-otel-adapter-web fluxcd-notifications-otel-adapter-web

RUN cd fluxcd-notifications-otel-adapter-web && \
    npm ci && \
    npm run generate

# RUN
FROM node:22-alpine

RUN apk add --no-cache kubectl gzip

COPY entrypoint.sh /entrypoint.sh

COPY --from=builder /opt/src/fluxcd-notifications-otel-adapter-server/node_modules /opt/app/fluxcd-notifications-otel-adapter/node_modules
COPY --from=builder /opt/src/fluxcd-notifications-otel-adapter-server/dist /opt/app/fluxcd-notifications-otel-adapter/dist
COPY --from=builder /opt/src/fluxcd-notifications-otel-adapter-web/.output/public /opt/app/fluxcd-notifications-otel-adapter/web
COPY fluxcd-notifications-otel-adapter-server/config.json /opt/app/fluxcd-notifications-otel-adapter/config.json
COPY fluxcd-notifications-otel-adapter-server/sql /opt/app/fluxcd-notifications-otel-adapter/sql
COPY package.json /opt/app/fluxcd-notifications-otel-adapter/package.json

WORKDIR /opt/app/fluxcd-notifications-otel-adapter

ENTRYPOINT [ "/entrypoint.sh" ]