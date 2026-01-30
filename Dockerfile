# Dockerfile for NeoKai
# Uses Bun runtime for fast builds and execution

FROM oven/bun:1.3.2-slim AS base
WORKDIR /app

# Install dependencies
FROM base AS deps
COPY package.json bun.lockb ./
COPY packages/cli/package.json ./packages/cli/
COPY packages/daemon/package.json ./packages/daemon/
COPY packages/web/package.json ./packages/web/
COPY packages/shared/package.json ./packages/shared/
RUN bun install --frozen-lockfile

# Build web production bundle
FROM deps AS build
COPY . .
RUN cd packages/web && bun run build

# Production image
FROM base AS production
WORKDIR /app

# Copy entrypoint script
COPY docker-entrypoint.sh /usr/local/bin/
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

# Expose port
EXPOSE 9983

# Set environment
ENV NODE_ENV=production

# Use entrypoint script that installs deps and builds web at runtime
ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
