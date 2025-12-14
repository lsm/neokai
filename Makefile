.PHONY: dev start daemon web self restart sync-sdk-types clean-cache clean-all build-prod test test-daemon test-coverage test-coverage-lcov e2e e2e-ui e2e-headed e2e-debug e2e-report docker-build docker-up docker-down docker-logs docker-self lint lint-fix format typecheck

# Unified server (daemon + web in single process) - RECOMMENDED
dev:
	@echo "🚀 Starting unified development server..."
	@echo "   Workspace: $(shell pwd)/tmp/workspace"
	@mkdir -p $(shell pwd)/tmp/workspace
	@lsof -ti:9283 | xargs kill -9 2>/dev/null || true
	@NODE_ENV=development bun run packages/cli/main.ts --workspace $(shell pwd)/tmp/workspace

# Self-hosting mode - use Liuboer to develop itself (production mode, no HMR)
self:
	@echo "🔄 Starting self-hosting server (production mode)..."
	@echo "   Workspace: $(shell pwd)"
	@echo "   Database: $(shell pwd)/tmp/self-dev/daemon.db"
	@echo "   Listening on port 9983 to avoid conflicts"
	@echo "📦 Building web production bundle..."
	@cd packages/web && bun run build
	@mkdir -p $(shell pwd)/tmp/self-dev
	@lsof -ti:9983 | xargs kill -9 2>/dev/null || true
	@NODE_ENV=production bun run packages/cli/main.ts --port 9983 --workspace $(shell pwd) --db-path $(shell pwd)/tmp/self-dev/daemon.db

start:
	@echo "🚀 Starting production server..."
	@lsof -ti:9283 | xargs kill -9 2>/dev/null || true
	@cd packages/cli && bun run start

# Standalone servers (for debugging) - LEGACY
daemon:
	@echo "⚠️  Starting daemon in standalone mode (legacy)..."
	@echo "💡 Tip: Use 'make dev' for unified server"
	@lsof -ti:8283 | xargs kill -9 2>/dev/null || true
	@cd packages/daemon && bun run dev

web:
	@echo "⚠️  Starting web in standalone mode (legacy)..."
	@echo "💡 Tip: Use 'make dev' for unified server"
	@lsof -ti:9283 | xargs kill -9 2>/dev/null || true
	@cd packages/web && bun run dev

sync-sdk-types:
	@echo "Syncing Claude SDK type definitions..."
	@mkdir -p packages/shared/src/sdk
	@cp packages/daemon/node_modules/@anthropic-ai/claude-agent-sdk/entrypoints/agentSdkTypes.d.ts packages/shared/src/sdk/entrypoints
	@cp packages/daemon/node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts packages/shared/src/sdk/
	@cp packages/daemon/node_modules/@anthropic-ai/claude-agent-sdk/sdk-tools.d.ts packages/shared/src/sdk/
	@echo "✓ SDK types synced to packages/shared/src/sdk/"

restart:
	@echo "🔄 Restarting all services..."
	@echo "Killing processes on ports 8283 and 9283..."
	@lsof -ti:8283 | xargs kill -9 2>/dev/null || true
	@lsof -ti:9283 | xargs kill -9 2>/dev/null || true
	@echo "🧹 Cleaning web cache..."
	@rm -rf packages/web/dist
	@rm -rf packages/web/.vite
	@echo "📦 Reinstalling dependencies..."
	@bun install
	@echo "🚀 Starting daemon..."
	@cd packages/daemon && bun run dev &
	@sleep 2
	@echo "🌐 Starting web..."
	@cd packages/web && bun run dev

# Clean Bun's package cache (helps with dependency issues)
clean-cache:
	@echo "🧹 Cleaning Bun package cache..."
	@rm -rf ~/.bun/install/cache
	@echo "�� Removing lockfiles..."
	@find . -name "bun.lock" -type f -delete
	@echo "✅ Cache cleaned! Run 'bun install' to rebuild cache."

# Clean all build artifacts and caches
clean-all: clean-cache
	@echo "🧹 Cleaning all build artifacts..."
	@rm -rf packages/web/dist
	@rm -rf packages/daemon/dist
	@rm -rf node_modules
	@rm -rf packages/*/node_modules
	@echo "✅ All clean! Run 'bun install' to reinstall dependencies."

# Build production bundles
build-prod:
	@echo "🏗️  Building production bundles..."
	@cd packages/web && bun run build
	@echo "✅ Production build complete!"

# Unit Testing
test:
	@echo "🧪 Running all tests..."
	@bun test

test-daemon:
	@echo "🧪 Running daemon tests..."
	@cd packages/daemon && bun test

test-coverage:
	@echo "📊 Running tests with coverage..."
	@bun test --coverage

test-coverage-lcov:
	@echo "📊 Generating LCOV coverage report..."
	@bun test --coverage --coverage-reporter=lcov
	@echo "✅ Coverage report generated at coverage/lcov.info"
	@echo "💡 Tip: Use an IDE extension (like Coverage Gutters for VS Code) to visualize coverage"

# E2E Testing with Playwright
e2e:
	@echo "🎭 Running E2E tests..."
	@cd packages/e2e && bun run test

e2e-ui:
	@echo "🎭 Running E2E tests in UI mode..."
	@cd packages/e2e && bun run test:ui

e2e-headed:
	@echo "🎭 Running E2E tests in headed mode..."
	@cd packages/e2e && bun run test:headed

e2e-debug:
	@echo "🎭 Running E2E tests in debug mode..."
	@cd packages/e2e && bun run test:debug

e2e-report:
	@echo "📊 Opening E2E test report..."
	@cd packages/e2e && bun run report

# Docker commands
docker-build:
	@echo "🐳 Building Docker image..."
	@docker compose build

docker-up:
	@echo "🐳 Starting Docker containers..."
	@docker compose up -d
	@echo "✅ Container started! Access at http://localhost:9983"

docker-down:
	@echo "🐳 Stopping Docker containers..."
	@docker compose down

docker-logs:
	@echo "📋 Showing Docker logs..."
	@docker compose logs -f

docker-self: docker-build docker-up
	@echo "🐳 Docker self-hosting mode started!"
	@echo "   Access at: http://localhost:9983"
	@echo "   View logs: make docker-logs"
	@echo "   Stop: make docker-down"

# Linting and Formatting
lint:
	@echo "🔍 Running linter..."
	@bun run lint

lint-fix:
	@echo "🔧 Running linter with auto-fix..."
	@bun run lint:fix

format:
	@echo "✨ Formatting code..."
	@bun run format

typecheck:
	@bun run typecheck