FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:22-bookworm-slim
# git, gh and the AWS CLI are tools Claude uses from Bash. The AWS CLI runs with the view-only rin-ai keys.
RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates curl gnupg ripgrep unzip awscli \
 && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg -o /usr/share/keyrings/githubcli-archive-keyring.gpg \
 && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" > /etc/apt/sources.list.d/github-cli.list \
 && apt-get update && apt-get install -y --no-install-recommends gh \
 && rm -rf /var/lib/apt/lists/* \
 && mkdir -p /data && chown node:node /data \
 # git over HTTPS authenticates with the installation token in $GH_TOKEN; the token never lands in .git/config.
 && git config --system credential.https://github.com.helper '!f() { echo username=x-access-token; echo "password=$GH_TOKEN"; }; f'
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
# The SDK ships the Claude Code CLI; expose it for one-time logins such as the Notion MCP.
RUN ln -s /app/node_modules/@anthropic-ai/claude-agent-sdk-linux-x64/claude /usr/local/bin/claude
COPY package.json ./
COPY prompts ./prompts
COPY workspace-template ./workspace-template
COPY deploy/compose.yaml ./deploy/compose.yaml
# The deploy workflow copies these two files out of the new image onto the EC2 host.
COPY deploy/ec2/deploy.sh ./deploy/ec2/deploy.sh
ENV NODE_ENV=production \
    RIN_WORKSPACE=/data/workspace \
    RIN_CLAUDE_CONFIG_DIR=/data/claude \
    CLAUDE_CONFIG_DIR=/data/claude
# The Agent SDK refuses bypassPermissions as root.
USER node
CMD ["node", "dist/worker/main.js"]
