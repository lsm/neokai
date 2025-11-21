.PHONY: daemon web sync-sdk-types

sync-sdk-types:
	@echo "Syncing Claude SDK type definitions..."
	@mkdir -p packages/shared/src/sdk
	@cp packages/daemon/node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts packages/shared/src/sdk/
	@cp packages/daemon/node_modules/@anthropic-ai/claude-agent-sdk/sdk-tools.d.ts packages/shared/src/sdk/
	@echo "✓ SDK types synced to packages/shared/src/sdk/"

daemon:
	@echo "Killing any process on port 8283..."
	@lsof -ti:8283 | xargs kill -9 2>/dev/null || true
	@echo "Starting daemon dev server..."
	@cd packages/daemon && bun run dev

web:
	@echo "Killing any process on port 9283..."
	@lsof -ti:9283 | xargs kill -9 2>/dev/null || true
	@echo "Starting web dev server..."
	@cd packages/web && bun run dev
