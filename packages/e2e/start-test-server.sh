#!/bin/bash
# Start dev server with dynamic port for E2E tests
# Prevents conflicts when multiple test sessions run concurrently

set -e

# Find an available port
PORT=$(node find-port.js)

# Export for the dev server
export PORT
export NODE_ENV=test
export DEFAULT_MODEL=haiku

echo "🚀 Starting test server on port $PORT"
echo "   DEFAULT_MODEL=$DEFAULT_MODEL"

# Start the dev server
cd ../cli && bun run dev --port $PORT
