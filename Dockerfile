# syntax=docker/dockerfile:1
# One image definition for the obbyx services: APP=facilitator (default) or APP=watcher.
#   docker build -t obbyx-facilitator .
#   docker build --build-arg APP=watcher -t obbyx-watcher .
ARG NODE_VERSION=24-bookworm-slim

FROM node:${NODE_VERSION} AS build
ARG APP=facilitator
RUN corepack enable && corepack prepare pnpm@12.16.1 --activate
WORKDIR /src
COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm --filter "@obbyx/${APP}..." build
# Self-contained copy of the app with its production + migration (prisma) dependencies.
RUN pnpm --filter "@obbyx/${APP}" deploy --legacy --prod /out

FROM node:${NODE_VERSION}
ARG APP=facilitator
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build --chown=node:node /out /app
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME ["/data"]
# Migrations run on every start (idempotent), then the service.
CMD ["sh", "-c", "npx prisma migrate deploy && exec node dist/main.js"]
