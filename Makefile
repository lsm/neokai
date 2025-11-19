.PHONY: daemon web

daemon:
	@echo "Killing any process on port 8283..."
	@lsof -ti:8283 | xargs kill -9 2>/dev/null || true
	@echo "Starting daemon dev server..."
	@cd packages/daemon && bun run dev

web:
	@echo "Killing any process on port 9283..."
	@lsof -ti:9283 | xargs kill -9 2>/dev/null || true
	@echo "Starting web dev server..."
	@cd packages/web && deno task dev
