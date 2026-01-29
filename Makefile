.PHONY: dev self other build test test-daemon test-web test-shared e2e e2e-ui lint lint-fix format typecheck check

dev:
	@echo "Starting development server..."
	@mkdir -p tmp/workspace
	@lsof -ti:9283 | xargs kill -9 2>/dev/null || true
	@NODE_ENV=development bun run packages/cli/main.ts --workspace tmp/workspace

self:
	@echo "Starting self server on port 9983..."
	@mkdir -p tmp/workspace
	@lsof -ti:9983 | xargs kill -9 2>/dev/null || true
	@NODE_ENV=development PORT=9983 bun run packages/cli/main.ts --workspace tmp/workspace

other:
	@echo "Starting other server on port 8283..."
	@mkdir -p tmp/workspace
	@lsof -ti:8283 | xargs kill -9 2>/dev/null || true
	@NODE_ENV=development PORT=8283 bun run packages/cli/main.ts --workspace tmp/workspace

build:
	@echo "Building web package..."
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
