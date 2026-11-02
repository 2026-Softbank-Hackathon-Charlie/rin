FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:22-bookworm-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates curl ripgrep \
 && rm -rf /var/lib/apt/lists/* \
 && mkdir -p /data && chown node:node /data
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
COPY prompts ./prompts
COPY workspace-template ./workspace-template
COPY deploy/compose.yaml ./deploy/compose.yaml
ENV NODE_ENV=production \
    RIN_WORKSPACE=/data/workspace \
    RIN_CLAUDE_CONFIG_DIR=/data/claude
# The Agent SDK refuses bypassPermissions as root.
USER node
CMD ["node", "dist/worker/main.js"]
