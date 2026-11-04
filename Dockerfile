FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:22-bookworm-slim
# git, gh, the AWS CLI and psql are tools Claude uses from Bash. The AWS CLI runs with the view-only rin-ai keys;
# psql logs in as the read-only role rin_reader (src/db/reader.ts).
# The worker uses the Docker CLI to start a sandbox container per run from this same image (src/worker/sandbox.ts).
# In the sandbox Claude may use sudo to install packages; the worker and the gateway run with no-new-privileges,
# so sudo does nothing there.
RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates curl gnupg ripgrep unzip awscli postgresql-client sudo \
 && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg -o /usr/share/keyrings/githubcli-archive-keyring.gpg \
 && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" > /etc/apt/sources.list.d/github-cli.list \
 && curl -fsSL https://download.docker.com/linux/debian/gpg | gpg --dearmor -o /usr/share/keyrings/docker.gpg \
 && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/docker.gpg] https://download.docker.com/linux/debian bookworm stable" > /etc/apt/sources.list.d/docker.list \
 && apt-get update && apt-get install -y --no-install-recommends gh docker-ce-cli \
 && rm -rf /var/lib/apt/lists/* \
 && echo 'node ALL=(ALL) NOPASSWD:ALL' > /etc/sudoers.d/node && chmod 440 /etc/sudoers.d/node \
 && mkdir -p /data && chown node:node /data \
 # git over HTTPS authenticates with the installation token in $GH_TOKEN; the token never lands in .git/config.
 && git config --system credential.https://github.com.helper '!f() { echo username=x-access-token; echo "password=$GH_TOKEN"; }; f'
# Chromium, Korean fonts and mermaid-cli let Claude render diagrams and HTML pages to PNG
# (workspace-template/skills/visuals). puppeteer uses the system Chromium instead of downloading one.
# The container has no user namespaces for Chromium's sandbox, so the Debian launcher adds --no-sandbox.
RUN apt-get update \
 && apt-get install -y --no-install-recommends chromium fonts-noto-cjk \
 && rm -rf /var/lib/apt/lists/* \
 && echo 'export CHROMIUM_FLAGS="$CHROMIUM_FLAGS --no-sandbox"' > /etc/chromium.d/rin-no-sandbox \
 && PUPPETEER_SKIP_DOWNLOAD=true npm install -g @mermaid-js/mermaid-cli@12.0.0 puppeteer@25.14.0 \
 && npm cache clean --force
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium
# mise installs toolchains (Go, Python, Java, kubectl, ...) without root. They and the Go, npm and pip caches live
# under /data/tools, which is on the host, so what Claude installs once stays across runs and deploys.
# The charlie CLI keeps its login in CHARLIE_CONFIG_DIR, so a login made in one run is used by the next. Only charlie
# reads it. Other tools keep their settings under $HOME, outside the shared /data, so a sandbox cannot plant a git
# config that the worker would read.
# GOPRIVATE lets go install fetch the team's private modules (the charlie CLI) through git with $GH_TOKEN.
RUN curl -fsSL -o /usr/local/bin/mise https://github.com/jdx/mise/releases/download/v2026.10.25/mise-v2026.10.25-linux-x64 \
 && echo "5d362ecc578dc7c146679b841dda949d6472cbf86ff5635db7afdca1b6b3fd87  /usr/local/bin/mise" | sha256sum -c - \
 && chmod 755 /usr/local/bin/mise
ENV MISE_DATA_DIR=/data/tools/mise \
    MISE_GLOBAL_CONFIG_FILE=/data/tools/mise/config.toml \
    MISE_TRUSTED_CONFIG_PATHS=/data/workspace \
    MISE_YES=1 \
    GOPATH=/data/tools/go \
    XDG_CACHE_HOME=/data/tools/cache \
    CHARLIE_CONFIG_DIR=/data/tools/charlie \
    GOPRIVATE=github.com/2026-Softbank-Hackathon-Charlie \
    npm_config_cache=/data/tools/cache/npm \
    PATH=/data/tools/mise/shims:/data/tools/go/bin:$PATH
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
# The SDK ships the Claude Code CLI; expose it for one-time logins such as the Notion MCP.
RUN ln -s /app/node_modules/@anthropic-ai/claude-agent-sdk-linux-x64/claude /usr/local/bin/claude
COPY package.json ./
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
