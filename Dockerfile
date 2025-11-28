# Dockerfile for Liuboer
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

# Copy dependencies
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/packages/cli/node_modules ./packages/cli/node_modules
COPY --from=deps /app/packages/daemon/node_modules ./packages/daemon/node_modules
COPY --from=deps /app/packages/web/node_modules ./packages/web/node_modules
COPY --from=deps /app/packages/shared/node_modules ./packages/shared/node_modules

# Copy source code
COPY package.json bun.lockb ./
COPY packages ./packages

# Copy built web assets
COPY --from=build /app/packages/web/dist ./packages/web/dist

# Expose port
EXPOSE 9983

# Set environment
ENV NODE_ENV=production

# Run the unified server
CMD ["bun", "run", "packages/cli/main.ts", "--port", "9983", "--workspace", "/workspace", "--db-path", "/data/daemon.db"]
