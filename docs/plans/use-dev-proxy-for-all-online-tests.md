# Plan: Use Dev Proxy for All Online Tests

**Created:** March 2026

## Goal

Replace the current internal mock SDK approach with Microsoft Dev Proxy for all online tests that don't require real AI API calls. This will improve test stability, reduce costs, and provide a more realistic simulation of API behavior while maintaining test effectiveness.

## Background

### Current Approach
The codebase uses an internal mock SDK (`packages/daemon/tests/helpers/mock-sdk.ts`) that:
- Intercepts the SDK at the `queryRunner.start()` level
- Feeds scripted responses through the real message handling pipeline
- Is controlled via `NEOKAI_AGENT_SDK_MOCK=1` environment variable
- Works well but requires maintaining internal mock code

### Dev Proxy Approach
[Dev Proxy](https://github.com/dotnet/dev-proxy) is Microsoft's API simulation tool that:
- Intercepts HTTP traffic at the network level (runs as a separate process)
- Mocks API responses via JSON configuration files
- Can simulate errors, throttling, and realistic API behavior
- Has an [Anthropic Claude API sample](https://github.com/pnp/proxy-samples/tree/main/samples/simulate-anthropic)

### Key Benefits
- **Test stability**: No more flaky internal mock state
- **Cost reduction**: Zero API calls during tests
- **Realistic simulation**: Can test error handling, throttling, rate limits
- **Maintainability**: Mock responses are declarative JSON files, not code
- **Cross-language**: Works with any HTTP client (SDK implementation changes won't break mocks)

## Tasks

### Task 1: Research Dev Proxy integration requirements

**Agent: general**

Investigate how to configure Dev Proxy to work with the Claude Agent SDK:

1. Research how the SDK makes HTTP requests (what environment variables it respects)
2. Determine if `HTTP_PROXY`/`HTTPS_PROXY` environment variables work with the SDK
3. Identify any SDK-specific configuration needed to route traffic through a proxy
4. Document the proxy configuration approach (port, cert trust, etc.)

**Deliverables:**
- Documentation of how the SDK can be configured to use a proxy
- List of environment variables needed
- Any SDK limitations or workarounds

**Acceptance Criteria:**
- Clear documentation of the proxy configuration approach
- Verified approach for routing SDK HTTP traffic through a proxy

### Task 2: Set up Dev Proxy infrastructure

**Agent: coder**

Create the foundational Dev Proxy setup for the test environment:

1. Install Dev Proxy (via brew on macOS, apt/script on Linux)
2. Create `.devproxy/` directory in the repository with:
   - `devproxyrc.json` - Main configuration
   - `mocks.json` - Initial mock responses for Anthropic API
3. Create npm/package scripts to start/stop Dev Proxy
4. Configure Dev Proxy to run on a fixed port (e.g., 8000)

Reference the [Anthropic simulation sample](https://github.com/pnp/proxy-samples/tree/main/samples/simulate-anthropic) for mock response format.

**Deliverables:**
- `.devproxy/` directory with configuration files
- npm scripts: `test:proxy:start`, `test:proxy:stop`
- Documentation in README or CLAUDE.md

**Acceptance Criteria:**
- Dev Proxy starts successfully with `bun run test:proxy:start`
- Dev Proxy mocks a basic Anthropic API request successfully
- Changes must be on a feature branch with a GitHub PR created via `gh pr create`

### Task 3: Create mock response files for common scenarios

**Agent: coder**

Create comprehensive mock response files based on the existing mock-sdk.ts scenarios:

1. Basic text responses (simple replies, multi-turn)
2. Tool use responses (tool calls, tool results)
3. Error scenarios (rate limiting, API errors, timeouts)
4. Room-specific responses (planner, coder, reviewer, leader flows)
5. Streaming responses (if supported by Dev Proxy)

Files to create in `.devproxy/`:
- `mocks-basic.json` - Simple text responses
- `mocks-tool-use.json` - Tool call scenarios
- `mocks-errors.json` - Error responses
- `mocks-room.json` - Room multi-agent scenarios

**Deliverables:**
- Set of mock JSON files covering common test scenarios
- Documentation of available mock scenarios

**Acceptance Criteria:**
- Mock files follow Dev Proxy schema
- Coverage of at least 80% of current mock-sdk.ts scenarios
- Changes must be on a feature branch with a GitHub PR created via `gh pr create`

### Task 4: Create test helper for Dev Proxy integration

**Agent: coder**

Create a test helper module that manages Dev Proxy lifecycle and configuration:

1. Create `packages/daemon/tests/helpers/dev-proxy.ts`:
   - `startDevProxy()` - Start Dev Proxy process
   - `stopDevProxy()` - Stop Dev Proxy process
   - `loadMockFile(path)` - Switch active mock file
   - `waitForProxy()` - Wait for proxy to be ready
2. Integrate with existing `createDaemonServer()` helper
3. Handle process cleanup on test failure

**Deliverables:**
- `packages/daemon/tests/helpers/dev-proxy.ts` helper module
- Updated `daemon-server.ts` to optionally use Dev Proxy

**Acceptance Criteria:**
- Helper starts/stops Dev Proxy reliably
- Process cleanup works correctly on test failure
- Changes must be on a feature branch with a GitHub PR created via `gh pr create`

### Task 5: Convert daemon tests to use Dev Proxy

**Agent: coder**

Update the daemon test infrastructure to use Dev Proxy:

1. Add new environment variable `NEOKAI_USE_DEV_PROXY=1`
2. Update CI configuration (`.github/workflows/main.yml`) to:
   - Install Dev Proxy in CI
   - Start Dev Proxy before tests
   - Set `HTTP_PROXY` and `HTTPS_PROXY` environment variables
   - Configure mock SDK flag appropriately
3. Update test files that currently use `NEOKAI_AGENT_SDK_MOCK`:
   - Keep both options working during transition
   - Tests should work with either mock approach

**Deliverables:**
- Updated CI configuration with Dev Proxy setup
- Environment variable documentation
- Updated test files

**Acceptance Criteria:**
- Tests pass with `NEOKAI_USE_DEV_PROXY=1`
- Tests still pass with `NEOKAI_AGENT_SDK_MOCK=1` (backwards compatibility)
- Changes must be on a feature branch with a GitHub PR created via `gh pr create`

### Task 6: Validate and measure improvements

**Agent: general**

Run comprehensive validation and measure the impact:

1. Run all converted tests with Dev Proxy
2. Compare execution times with current mock approach
3. Verify API call counts (should be zero)
4. Document any test failures and resolution
5. Measure CI execution time improvement

**Deliverables:**
- Validation report with pass/fail status
- Performance comparison metrics
- List of any issues encountered

**Acceptance Criteria:**
- All converted tests pass
- API call count is zero during test runs
- Documentation of any limitations or caveats

## Dependencies

- Task 1 must complete before Tasks 2-5 (need to understand SDK proxy support)
- Task 2 must complete before Tasks 3-4 (need Dev Proxy infrastructure)
- Task 3 can run in parallel with Task 4 (mock files vs helper code)
- Task 5 depends on Tasks 2-4 (need complete infrastructure)
- Task 6 depends on Task 5 (need working implementation to validate)

## Execution Notes

- Tasks 2-5 should each create separate PRs for easier review
- Keep the existing `NEOKAI_AGENT_SDK_MOCK` approach working during transition
- Consider a feature flag approach to switch between mock implementations
- Dev Proxy must be installed on CI runners (GitHub Actions supports apt installation)

## Notes

### Dev Proxy Installation
```bash
# macOS
brew install dev-proxy

# Linux (CI)
curl -sSL https://aka.ms/devproxy-install | bash
```

### Environment Variables
```bash
# Enable Dev Proxy for tests
NEOKAI_USE_DEV_PROXY=1

# Proxy configuration (set by test helper or CI)
HTTP_PROXY=http://127.0.0.1:8000
HTTPS_PROXY=http://127.0.0.1:8000
NODE_TLS_REJECT_UNAUTHORIZED=0  # If using self-signed certs
```

### Potential Challenges
1. **SDK Proxy Support**: The Claude Agent SDK may not respect standard proxy environment variables. May need to use `ANTHROPIC_BASE_URL` to redirect to proxy.
2. **HTTPS/TLS**: Dev Proxy may need certificate trust configuration for HTTPS interception.
3. **Streaming**: Dev Proxy's support for streaming responses needs verification.
4. **CI Installation**: Dev Proxy needs to be installed on GitHub Actions runners.

### Fallback Strategy
If Dev Proxy integration proves too complex, we can:
1. Continue using the internal mock SDK approach
2. Enhance the existing mock-sdk.ts with more scenarios
3. Consider other mock approaches (WireMock, etc.)
