.PHONY: dev self run build test test-daemon test-web test-shared e2e e2e-ui lint lint-fix format typecheck check compile compile-all package-npm release

dev:
	@echo "Starting development server..."
	@mkdir -p tmp/workspace
	@lsof -ti:9283 | xargs kill -9 2>/dev/null || true
	@NODE_ENV=development bun run packages/cli/main.ts --workspace tmp/workspace

# Self-developing mode - production build serving the current directory on port 9983
# This is a convenience wrapper around `make run`
self:
	@$(MAKE) run WORKSPACE=$(shell pwd) PORT=9983

# Run production server with custom workspace and port
# Usage: make run WORKSPACE=/path/to/workspace PORT=8080
run:
	@if [ -z "$(WORKSPACE)" ]; then \
		echo "❌ Error: WORKSPACE parameter is required"; \
		echo "Usage: make run WORKSPACE=/path/to/workspace PORT=8080"; \
		exit 1; \
	fi
	@if [ -z "$(PORT)" ]; then \
		echo "❌ Error: PORT parameter is required"; \
		echo "Usage: make run WORKSPACE=/path/to/workspace PORT=8080"; \
		exit 1; \
	fi
	@echo "🚀 Starting production server..."
	@echo "   Workspace: $(WORKSPACE)"
	@echo "   Listening on port $(PORT)"
	@$(MAKE) build
	@lsof -ti:$(PORT) | xargs kill -9 2>/dev/null || true
	@NODE_ENV=production bun run packages/cli/main.ts --port $(PORT) --workspace $(WORKSPACE)

build:
	@echo "📦 Building web production bundle..."
	@cd packages/web && bun run build

test:
	@echo "Running all tests..."
	@bun run test

test-daemon:
	@echo "Running daemon tests..."
	@cd packages/daemon && bun test

test-web:
	@echo "Running web tests..."
	@cd packages/web && bunx vitest run

test-shared:
	@echo "Running shared tests..."
	@cd packages/shared && bun test

e2e:
	@echo "Running E2E tests..."
	@cd packages/e2e && bun run test

e2e-ui:
	@echo "Running E2E tests in UI mode..."
	@cd packages/e2e && bun run test:ui

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

# Full release pipeline: build + compile + package
release: compile-all package-npm
	@echo "Release artifacts ready in dist/npm/"
