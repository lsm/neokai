.PHONY: dev serve-random self self-test run run-e2e build test test-daemon test-web test-shared e2e e2e-ui lint lint-fix format typecheck check compile compile-all package-npm release sync-sdk-types setup-hooks setup

# Development server - uses random available port
# Usage: make dev WORKSPACE=/path/to/workspace
dev:
	@if [ -z "$(WORKSPACE)" ]; then \
		echo "Error: WORKSPACE parameter is required"; \
		echo "Usage: make dev WORKSPACE=/path/to/workspace"; \
		exit 1; \
	fi
	@echo "Finding available port..."
	@PORT=$$(node -e "const net = require('net'); const server = net.createServer(); server.listen(0, () => { const port = server.address().port; console.log(port); server.close(); });"); \
	echo "Starting development server on port $$PORT..."; \
	mkdir -p $(WORKSPACE); \
	echo ""; \
	echo "================================================"; \
	echo "🚀 Development server starting on http://localhost:$$PORT"; \
	echo "   Workspace: $(WORKSPACE)"; \
	echo "================================================"; \
	echo ""; \
	NODE_ENV=development NEOKAI_PORT=$$PORT bun run packages/cli/main.ts --workspace $(WORKSPACE) --port $$PORT

# Production server on random port - starts production build on available port
# Usage: make serve-random WORKSPACE=/path/to/workspace
serve-random:
	@if [ -z "$(WORKSPACE)" ]; then \
		echo "Error: WORKSPACE parameter is required"; \
		echo "Usage: make serve-random WORKSPACE=/path/to/workspace"; \
		exit 1; \
	fi
	@PORT=$$(node -e "const net = require('net'); const server = net.createServer(); server.listen(0, () => { const port = server.address().port; console.log(port); server.close(); });"); \
	echo "Running with PORT=$$PORT WORKSPACE=$(WORKSPACE)"; \
	$(MAKE) run PORT=$$PORT WORKSPACE=$(WORKSPACE)

# Self-developing mode - production build serving the current directory on port 9983
# This is a convenience wrapper around `make run`
self:
	@NEOKAI_SELF_MODE=1 $(MAKE) run WORKSPACE=$(shell pwd) PORT=9983

# Run E2E tests against the `make self` instance (requires `make self` to be running)
# Usage: make self-test TEST=tests/core/navigation-3-column.e2e.ts
#        make self-test (runs all tests)
self-test:
	@PLAYWRIGHT_BASE_URL=http://localhost:9983 cd packages/e2e && bunx playwright test $(TEST)

# Run production server with custom workspace and port
# Usage: make run WORKSPACE=/path/to/workspace PORT=8080
run:
	@if [ -z "$(WORKSPACE)" ]; then \
		echo "Error: WORKSPACE parameter is required"; \
		echo "Usage: make run WORKSPACE=/path/to/workspace [PORT=8080]"; \
		exit 1; \
	fi
	@mkdir -p tmp
	@if [ -n "$(PORT)" ]; then \
		echo "$(PORT)" > tmp/.dev-server-running; \
	fi
	@echo "Starting production server..."
	@echo "   Workspace: $(WORKSPACE)"
	@if [ -n "$(PORT)" ]; then \
		echo "   Listening on port $(PORT)"; \
	fi
	@$(MAKE) build
	@if [ -n "$(PORT)" ]; then \
		NODE_ENV=production bun run packages/cli/main.ts --port $(PORT) --workspace $(WORKSPACE); \
	else \
		NODE_ENV=production bun run packages/cli/main.ts --workspace $(WORKSPACE); \
	fi

# Run E2E tests with an auto-started server on a random port (self-contained, no server needed)
# Usage: make run-e2e TEST=tests/features/slash-cmd.e2e.ts
#        make run-e2e (runs all tests)
run-e2e:
	@PORT=$$(node -e "const net = require('net'); const s = net.createServer(); s.listen(0, () => { console.log(s.address().port); s.close(); });"); \
	echo "Running E2E tests on random port $$PORT..."; \
	cd packages/e2e && E2E_PORT=$$PORT bunx playwright test $(TEST)

build:
	@echo "📦 Building web production bundle..."
	@cd packages/web && bun run build

test: test-daemon test-web

test-1:
	@bun test --preload=./packages/daemon/tests/unit/setup.ts --dots packages/daemon/tests/unit packages/shared/tests --coverage --coverage-reporter=text --coverage-reporter=lcov --coverage-dir=coverage

test-daemon:
	@echo "Running daemon tests..."
	@NODE_ENV=test bun test --jobs=1 --preload=./packages/daemon/tests/unit/setup.ts --dots packages/daemon/tests/unit packages/shared/tests --coverage --coverage-reporter=text --coverage-reporter=lcov --coverage-dir=coverage

test-web:
	@echo "Running web tests..."
	@cd packages/web && bun run coverage

lint:
	@bun run lint

lint-fix:
	@bun run lint:fix

format:
	@bun run format

typecheck:
	@bun run typecheck

check:
	@bun run check

# Build compiled binary for current platform
compile:
	@bun run scripts/build-binary.ts --target bun-$(shell uname -s | tr '[:upper:]' '[:lower:]')-$(shell uname -m | sed 's/aarch64/arm64/' | sed 's/x86_64/x64/')

# Build compiled binaries for all platforms (cross-compilation)
compile-all:
	@bun run scripts/build-binary.ts

# Package npm packages from compiled binaries
package-npm:
	@bun run scripts/package-npm.ts

# Sync SDK type definitions from installed package to shared types
sync-sdk-types:
	@echo "Syncing Claude SDK type definitions..."
	@mkdir -p packages/shared/src/sdk
	@cp packages/daemon/node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts packages/shared/src/sdk/
	@cp packages/daemon/node_modules/@anthropic-ai/claude-agent-sdk/sdk-tools.d.ts packages/shared/src/sdk/
	@echo "SDK types synced to packages/shared/src/sdk/"

# Full release pipeline: build + compile + package
release: compile-all package-npm
	@echo "Release artifacts ready in dist/npm/"

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

# Install git hooks
setup-hooks:
	@echo "Installing git hooks..."
	@cp scripts/git-hooks/pre-commit .git/hooks/pre-commit
	@chmod +x .git/hooks/pre-commit
	@echo "✅ Git hooks installed"

# Full development environment setup
setup: setup-hooks
	@echo "✅ Development environment ready"