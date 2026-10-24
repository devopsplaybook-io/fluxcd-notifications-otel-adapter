# BUILD
FROM node:26-alpine AS builder

WORKDIR /opt/src

RUN apk add --no-cache bash git python3 perl alpine-sdk

COPY package.json package-lock.json ./
RUN npm ci

COPY . .
RUN npm run build && npm prune --omit=dev


# RUN
FROM node:26-alpine

ENV NODE_ENV=production

WORKDIR /opt/app

COPY --from=builder /opt/src/node_modules ./node_modules
COPY --from=builder /opt/src/dist ./dist
COPY --from=builder /opt/src/config.json ./config.json
COPY --from=builder /opt/src/package.json ./package.json

USER node

CMD ["node", "dist/App.js"]
