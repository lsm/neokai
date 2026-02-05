# E2E Tests

This package contains end-to-end tests for NeoKai using Playwright.

## Running Tests Locally

### Important: Avoid Port Conflicts

The default Playwright configuration uses port **9283**. If you're running a development server on this port, you must either:

1. **Reuse your existing server** (recommended):
   ```bash
   PLAYWRIGHT_BASE_URL=http://localhost:9283 bun test
   ```

2. **Use a different port for testing**:
   ```bash
   PLAYWRIGHT_BASE_URL=http://localhost:9999 bun test
   ```

### Running All Tests

```bash
bun test
```

### Running Specific Tests

```bash
# Run a specific test file
bunx playwright test tests/reconnection-basic.e2e.ts

# Run tests matching a pattern
bunx playwright test reconnection
```

### Test Modes

```bash
# UI mode (interactive)
bun run test:ui

# Headed mode (see browser)
bun run test:headed

# Debug mode
bun run test:debug

# With coverage
bun run test:coverage
```

## Test Organization

Tests are organized into 3 projects for parallel execution:

1. **read-only** - Tests that don't create sessions (fully parallel)
2. **isolated-sessions** - Tests with proper cleanup (parallel)
3. **serial** - Complex tests requiring serial execution

## Environment Variables

- `PLAYWRIGHT_BASE_URL` - URL of the server to test (default: http://localhost:9283)
- `COVERAGE` - Set to "true" to collect coverage reports
- `CI` - Automatically set in CI environments
- `DEFAULT_MODEL` - AI model to use for tests (default: sonnet)

## Troubleshooting

### Port Already in Use

If you see "port 9283 is already in use", either:
- Stop the conflicting process
- Use `PLAYWRIGHT_BASE_URL` to point to your existing server
- Change the port in your dev server

### Tests Timing Out

Increase timeouts in `playwright.config.ts` if tests are timing out in your environment.
