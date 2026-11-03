FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

# Only the browser bundle of Mermaid is kept; bin/mmd2png.mjs runs it in Chromium.
FROM node:22-bookworm-slim AS mermaid
WORKDIR /m
RUN npm pack -q mermaid@12.2.0 && tar -xzf mermaid-12.2.0.tgz package/dist/mermaid.min.js

FROM node:22-bookworm-slim
# git, gh, the AWS CLI and psql are tools Claude uses from Bash. The AWS CLI runs with the view-only rin-ai keys;
# psql logs in as the read-only role rin_reader (src/db/reader.ts).
RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates curl gnupg ripgrep unzip awscli postgresql-client \
 && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg -o /usr/share/keyrings/githubcli-archive-keyring.gpg \
 && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" > /etc/apt/sources.list.d/github-cli.list \
 && apt-get update && apt-get install -y --no-install-recommends gh \
 && rm -rf /var/lib/apt/lists/* \
 && mkdir -p /data && chown node:node /data \
 # git over HTTPS authenticates with the installation token in $GH_TOKEN; the token never lands in .git/config.
 && git config --system credential.https://github.com.helper '!f() { echo username=x-access-token; echo "password=$GH_TOKEN"; }; f'
# Chromium and Korean fonts let Claude render Mermaid diagrams (mmd2png) and HTML pages to PNG
# (workspace-template/skills/visuals). The container has no user namespaces for Chromium's sandbox,
# so the Debian launcher adds --no-sandbox.
RUN apt-get update \
 && apt-get install -y --no-install-recommends chromium fonts-noto-cjk \
 && rm -rf /var/lib/apt/lists/* \
 && echo 'export CHROMIUM_FLAGS="$CHROMIUM_FLAGS --no-sandbox"' > /etc/chromium.d/rin-no-sandbox \
 && printf '#!/bin/sh\nexec node /app/bin/mmd2png.mjs "$@"\n' > /usr/local/bin/mmd2png \
 && chmod +x /usr/local/bin/mmd2png
COPY --from=mermaid /m/package/dist/mermaid.min.js /opt/mermaid/mermaid.min.js
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
# The SDK ships the Claude Code CLI; expose it for one-time logins such as the Notion MCP.
RUN ln -s /app/node_modules/@anthropic-ai/claude-agent-sdk-linux-x64/claude /usr/local/bin/claude
COPY package.json ./
COPY bin ./bin
COPY prompts ./prompts
COPY workspace-template ./workspace-template
COPY deploy/compose.db.yaml deploy/compose.app.yaml ./deploy/
# The deploy workflow copies these two files out of the new image onto the EC2 host.
COPY deploy/ec2/deploy.sh ./deploy/ec2/deploy.sh
ENV NODE_ENV=production \
    RIN_WORKSPACE=/data/workspace \
    RIN_CLAUDE_CONFIG_DIR=/data/claude \
    CLAUDE_CONFIG_DIR=/data/claude
# The Agent SDK refuses bypassPermissions as root.
USER node
CMD ["node", "dist/worker/main.js"]
