#!/bin/sh
set -e

echo "🔧 Installing dependencies..."
bun install --frozen-lockfile

echo "📦 Building web production bundle..."
cd packages/web && bun run build && cd ../..

echo "🚀 Starting Liuboer in self-hosting mode..."
exec bun run packages/cli/main.ts --port 9983 --workspace /workspace --db-path /data/daemon.db
