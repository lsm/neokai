.PHONY: dev worktree-dev start daemon web self profile other restart sync-sdk-types sync-claude-prompts clean-cache clean-all build-prod test test-daemon test-coverage test-coverage-lcov e2e e2e-ui e2e-headed e2e-debug e2e-report docker-build docker-up docker-down docker-logs docker-self lint lint-fix format typecheck merge-session outdated update

# Unified server (daemon + web in single process) - RECOMMENDED
dev:
	@echo "🚀 Starting unified development server..."
	@echo "   Workspace: $(shell pwd)/tmp/workspace"
	@mkdir -p $(shell pwd)/tmp/workspace
	@lsof -ti:9283 | xargs kill -9 2>/dev/null || true
	@NODE_ENV=development bun run packages/cli/main.ts --workspace $(shell pwd)/tmp/workspace

# Worktree development server - uses dynamic port for concurrent sessions
worktree-dev:
	@echo "🌳 Starting worktree development server..."
	@echo "📦 Installing dependencies..."
	@bun install --silent
	@GIT_COMMON_DIR=$$(git rev-parse --git-common-dir 2>/dev/null); \
	if [ -n "$$GIT_COMMON_DIR" ] && [ "$$GIT_COMMON_DIR" != ".git" ]; then \
		ROOT_REPO=$$(dirname "$$GIT_COMMON_DIR"); \
		echo "📋 Copying .env files from root repository..."; \
		if [ -f "$$ROOT_REPO/.env" ]; then \
			cp "$$ROOT_REPO/.env" ./.env && echo "   ✅ Copied .env"; \
		fi; \
		if [ -f "$$ROOT_REPO/packages/daemon/.env" ]; then \
			mkdir -p ./packages/daemon && cp "$$ROOT_REPO/packages/daemon/.env" ./packages/daemon/.env && echo "   ✅ Copied packages/daemon/.env"; \
		fi; \
		if [ -f "$$ROOT_REPO/packages/cli/.env" ]; then \
			mkdir -p ./packages/cli && cp "$$ROOT_REPO/packages/cli/.env" ./packages/cli/.env && echo "   ✅ Copied packages/cli/.env"; \
		fi; \
	fi
	@echo "🔍 Finding available port..."
	@PORT=$$(node -e "const net = require('net'); const server = net.createServer(); server.listen(0, () => { console.log(server.address().port); server.close(); });"); \
	echo ""; \
	echo "✅ Found available port: $$PORT"; \
	echo "🌐 Web UI will be available at: http://localhost:$$PORT"; \
	echo "   Workspace: $(shell pwd)/tmp/workspace"; \
	echo ""; \
	mkdir -p $(shell pwd)/tmp/workspace; \
	NODE_ENV=development bun run packages/cli/main.ts --port $$PORT --workspace $(shell pwd)/tmp/workspace

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

# Profiling mode - production build with debugging and CPU profiling
profile:
	@echo "🔍 Starting profiling server (production mode with debugging)..."
	@echo "   Workspace: $(shell pwd)/tmp/profiling"
	@echo "   Database: $(shell pwd)/tmp/profiling/data/daemon.db"
	@echo "   Listening on port 8302"
	@echo "   Inspector: Web debugger available at https://debug.bun.sh"
	@echo "   CPU Profile: Profile data will be saved on exit"
	@echo "📦 Building web production bundle..."
	@cd packages/web && bun run build
	@mkdir -p $(shell pwd)/tmp/profiling/data
	@lsof -ti:8302 | xargs kill -9 2>/dev/null || true
	@NODE_ENV=production bun --inspect --cpu-prof run packages/cli/main.ts --port 8302 --workspace $(shell pwd)/tmp/profiling --db-path $(shell pwd)/tmp/profiling/data/daemon.db

# Other workspace mode - production build with custom workspace and port
# Usage: make other WORKSPACE=/path/to/workspace PORT=8080
other:
	@if [ -z "$(WORKSPACE)" ]; then \
		echo "❌ Error: WORKSPACE parameter is required"; \
		echo "Usage: make other WORKSPACE=/path/to/workspace PORT=8080"; \
		exit 1; \
	fi
	@if [ -z "$(PORT)" ]; then \
		echo "❌ Error: PORT parameter is required"; \
		echo "Usage: make other WORKSPACE=/path/to/workspace PORT=8080"; \
		exit 1; \
	fi
	@echo "🚀 Starting production server for custom workspace..."
	@echo "   Workspace: $(WORKSPACE)"
	@echo "   Listening on port $(PORT)"
	@echo "📦 Building web production bundle..."
	@cd packages/web && bun run build
	@lsof -ti:$(PORT) | xargs kill -9 2>/dev/null || true
	@NODE_ENV=production bun run packages/cli/main.ts --port $(PORT) --workspace $(WORKSPACE)

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
	@mkdir -p packages/shared/src/sdk/entrypoints/sdk
	@mkdir -p packages/shared/src/sdk/transport
	@# Copy main entry files
	@cp packages/daemon/node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts packages/shared/src/sdk/
	@cp packages/daemon/node_modules/@anthropic-ai/claude-agent-sdk/sdk-tools.d.ts packages/shared/src/sdk/
	@# Copy entrypoints
	@cp packages/daemon/node_modules/@anthropic-ai/claude-agent-sdk/entrypoints/agentSdkTypes.d.ts packages/shared/src/sdk/entrypoints/
	@cp packages/daemon/node_modules/@anthropic-ai/claude-agent-sdk/entrypoints/sandboxTypes.d.ts packages/shared/src/sdk/entrypoints/
	@# Copy SDK type modules
	@cp packages/daemon/node_modules/@anthropic-ai/claude-agent-sdk/entrypoints/sdk/*.d.ts packages/shared/src/sdk/entrypoints/sdk/
	@# Copy transport types
	@cp packages/daemon/node_modules/@anthropic-ai/claude-agent-sdk/transport/*.d.ts packages/shared/src/sdk/transport/
	@echo "✓ SDK types synced to packages/shared/src/sdk/"

sync-claude-prompts:
	@echo "📥 Syncing Claude Code system prompts..."
	@TEMP_DIR=$$(mktemp -d); \
	echo "   Cloning repository to temporary location..."; \
	git clone --depth 1 https://github.com/Piebald-AI/claude-code-system-prompts.git "$$TEMP_DIR" 2>&1 | grep -v "Cloning into" || true; \
	if [ -d "$$TEMP_DIR/system-prompts" ]; then \
		echo "   Copying system-prompts to docs/claude-code-system-prompts..."; \
		mkdir -p docs/claude-code-system-prompts; \
		rm -rf docs/claude-code-system-prompts/*; \
		cp -r "$$TEMP_DIR/system-prompts/"* docs/claude-code-system-prompts/; \
		echo "   Cleaning up temporary files..."; \
		rm -rf "$$TEMP_DIR"; \
		echo "✅ Claude Code system prompts synced to docs/claude-code-system-prompts/"; \
		echo "📊 Files synced:"; \
		ls -1 docs/claude-code-system-prompts/ | sed 's/^/   - /'; \
	else \
		echo "❌ Error: system-prompts directory not found in repository"; \
		rm -rf "$$TEMP_DIR"; \
		exit 1; \
	fi

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

# Check for outdated dependencies across all workspace packages
outdated:
	@echo "📦 Checking for outdated dependencies..."
	@echo ""
	@echo "=== Root ==="
	@bun outdated || true
	@echo ""
	@echo "=== packages/cli ==="
	@cd packages/cli && bun outdated || true
	@echo ""
	@echo "=== packages/daemon ==="
	@cd packages/daemon && bun outdated || true
	@echo ""
	@echo "=== packages/web ==="
	@cd packages/web && bun outdated || true
	@echo ""
	@echo "=== packages/shared ==="
	@cd packages/shared && bun outdated || true

# Interactive dependency update across all workspace packages
update:
	@echo "🔄 Updating dependencies interactively..."
	@echo ""
	@echo "=== Root ==="
	@bun update --interactive
	@echo ""
	@echo "=== packages/cli ==="
	@cd packages/cli && bun update --interactive
	@echo ""
	@echo "=== packages/daemon ==="
	@cd packages/daemon && bun update --interactive
	@echo ""
	@echo "=== packages/web ==="
	@cd packages/web && bun update --interactive
	@echo ""
	@echo "=== packages/shared ==="
	@cd packages/shared && bun update --interactive
	@echo ""
	@echo "✅ All packages updated!"

# Merge worktree session to root repo branch - complete workflow automation
merge-session:
	@echo "🔀 Completing worktree session workflow..."
	@CURRENT_BRANCH=$$(git rev-parse --abbrev-ref HEAD); \
	ROOT_REPO=$$(git rev-parse --show-superproject-working-tree); \
	if [ -z "$$ROOT_REPO" ]; then \
		echo "❌ Error: Not in a worktree. This command is for worktree sessions only."; \
		exit 1; \
	fi; \
	TARGET_BRANCH=$$(git --git-dir=$$ROOT_REPO/.git --work-tree=$$ROOT_REPO rev-parse --abbrev-ref HEAD); \
	if [ "$$CURRENT_BRANCH" = "$$TARGET_BRANCH" ]; then \
		echo "❌ Error: Already on target branch ($$TARGET_BRANCH). Run this from a worktree session branch."; \
		exit 1; \
	fi; \
	echo "📝 Session branch: $$CURRENT_BRANCH"; \
	echo "📁 Root repository: $$ROOT_REPO"; \
	echo "🎯 Target branch: $$TARGET_BRANCH"; \
	echo ""; \
	echo "Step 1: Pulling and rebasing $$TARGET_BRANCH..."; \
	git --git-dir=$$ROOT_REPO/.git --work-tree=$$ROOT_REPO fetch origin $$TARGET_BRANCH && \
	git --git-dir=$$ROOT_REPO/.git --work-tree=$$ROOT_REPO rebase origin/$$TARGET_BRANCH $$TARGET_BRANCH && \
	echo "✅ $$TARGET_BRANCH branch updated"; \
	echo ""; \
	echo "Step 2: Merging session branch to $$TARGET_BRANCH..."; \
	git --git-dir=$$ROOT_REPO/.git --work-tree=$$ROOT_REPO checkout $$TARGET_BRANCH && \
	git --git-dir=$$ROOT_REPO/.git --work-tree=$$ROOT_REPO merge --ff-only $$CURRENT_BRANCH && \
	echo "✅ Session merged to $$TARGET_BRANCH"; \
	echo ""; \
	echo "Step 3: Pushing to remote..."; \
	git --git-dir=$$ROOT_REPO/.git --work-tree=$$ROOT_REPO push origin $$TARGET_BRANCH && \
	echo "✅ Changes pushed to remote"; \
	echo ""; \
	echo "🎉 Workflow complete! Session branch merged to $$TARGET_BRANCH and pushed."; \
	echo "💡 You can now delete this worktree session from the UI."