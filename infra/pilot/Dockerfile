FROM node:24-bookworm-slim@sha256:01d566e8d94d8c619591d78652babfccd3c6992a3dffa9ed5ab39e11cf6c70e9 AS tooling
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.test.json ./
COPY src ./src
COPY scripts ./scripts
COPY db ./db
COPY test ./test
RUN npm run build && npm run build:pilot-engine

FROM node:24-bookworm-slim@sha256:01d566e8d94d8c619591d78652babfccd3c6992a3dffa9ed5ab39e11cf6c70e9 AS runtime
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts
COPY --from=tooling /app/dist ./dist
COPY scripts/pilot/run-worker.mjs ./scripts/pilot/run-worker.mjs
USER 1000:1000
