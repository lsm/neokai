# Unit Test Coverage Report

> **Generated**: 2026-03-11

## Methodology

- **Coverage Type**: Line coverage, branch coverage, and function coverage
- **Measurement Tool**: Bun's built-in test coverage (`bun test --coverage`)
- **Note**: Coverage is measured per-package. The shared package coverage is measured by running its own tests, not inferred from the daemon test run.

### Reproducibility Commands

```bash
# Daemon package coverage
cd packages/daemon && bun test tests/unit --coverage

# Web package coverage
cd packages/web && bunx vitest run --reporter default --coverage

# Shared package coverage
cd packages/shared && bun test --coverage
```

---

## Summary

### Daemon Package
- **Tests**: 3635 pass, 6 fail, 1 skip across 122 files
- **Total Tests**: 3642 tests
- **Duration**: 34.14s

### Web Package
- **Tests**: 3628 pass across 118 test files
- **Duration**: ~13s

### Shared Package
- **Tests**: 380 pass across 15 files
- **Duration**: 6.11s

---

## Coverage by Package/Module

### Daemon Package (packages/daemon)

| Module | Coverage | Assessment |
|--------|----------|------------|
| Agent (core) | ~90%+ | Good |
| Providers | ~80%+ | Good |
| RPC Handlers | ~70-100% | Good to Moderate |
| Room Agents | ~55-100% | Moderate to Good |
| Room Runtime | ~39-87% | Low to Good |
| Session | ~77-100% | Good |
| Storage | ~70-100% | Good |
| Github | 0% | No Coverage |
| CLI Agent Registry | 0% | No Coverage |

**Note**: The shared package's message-hub components (router, websocket-client-transport, channel-manager) are not included in daemon coverage measurement. They have their own dedicated tests in the shared package.

### Web Package (packages/web)

| Module | Coverage | Assessment |
|--------|----------|------------|
| hooks | 99.07% | Excellent |
| components/sdk | 94.35% | Excellent |
| components/ui | 96.77% | Excellent |
| components/chat | 100% | Excellent |
| components/room | 76.58% | Moderate |
| islands | 69.04% | Moderate |
| lib | 77.51% | Moderate |

### Shared Package (packages/shared)

| Module | Coverage | Assessment |
|--------|----------|------------|
| message-hub/router.ts | 100% | Excellent |
| message-hub/websocket-client-transport.ts | 85.19% | Good |
| message-hub/message-hub.ts | 99.53% | Excellent |
| message-hub/channel-manager.ts | 89.66% | Good |
| logger.ts | 100% | Excellent |
| sdk/type-guards.ts | 97.81% | Excellent |
| utils.ts | 100% | Excellent |

---

## Files with Low or No Coverage

### Daemon - 0% Coverage

1. `src/lib/github/github-service.ts` - No unit tests
2. `src/lib/room/agents/cli-agent-registry.ts` - No unit tests
3. `../shared/src/prompts/templates.ts` - No unit tests

### Daemon - Low Coverage (< 50%)

1. `src/lib/room/runtime/room-runtime-service.ts` - 39.13%
2. `src/lib/rpc-handlers/room-handlers.ts` - 47.83%

### Web - Low Coverage (< 60%)

1. `src/lib/room-store.ts` - 35.91%
2. `src/components/room/GoalsEditor.tsx` - 48.67%
3. `src/islands/RoomContextPanel.tsx` - 50%
4. `src/lib/router.ts` - 53.52%
5. `src/lib/connection-manager.ts` - 87.5% (branch coverage only)

### Shared Package - Low Coverage Areas

1. `src/message-hub/channel-manager.ts` - 89.66% lines (44.44% functions - some helper methods not called directly)
2. `src/message-hub/websocket-client-transport.ts` - 85.19% lines (83.33% functions - error path coverage)
3. `src/message-hub/typed-hub.ts` - 96.34% lines (88% functions)

---

## Recommendations

### Priority 1: Add Unit Tests to Uncovered Files

1. **github-service.ts** - Core GitHub integration logic
   - Add tests for API calls, rate limiting, error handling

2. **cli-agent-registry.ts** - CLI agent registration
   - Add tests for agent lifecycle, command registration

3. **prompts/templates.ts** - Prompt templates
   - Add tests for template rendering and variable substitution

### Priority 2: Improve Low Coverage Areas

1. **room-runtime-service.ts** (39%) - Room orchestration
   - Add tests for room state management, worker coordination

2. **room-handlers.ts** (47%) - Room RPC handlers
   - Add tests for create, join, leave room operations

3. **room-store.ts** (35.91%) - Frontend room state
   - Add tests for room creation, task management, UI state

4. **GoalsEditor.tsx** (48.67%) - Room goal editing
   - Add tests for goal CRUD operations, validation

### Priority 3: Test Maintenance

1. Fix 6 failing tests in daemon package
2. Address the test failures in room-runtime tests (worktree cleanup, session factory issues)
3. Improve test isolation to reduce "unhandled error between tests" warnings

---

## Coverage Gaps Summary

| Area | Gap | Priority |
|------|-----|----------|
| GitHub integration | No tests | High |
| CLI agent registry | 0% | Medium |
| Room runtime service | 39% | High |
| Room frontend state | 36% | High |
| Prompts/templates | 0% | Low |

---

## Test Statistics

- **Total unit tests**: 7,643 (3635 daemon + 3628 web + 380 shared)
- **Test files**: 122 (daemon) + 118 (web) + 15 (shared)
- **Expect calls**: 7,039 (daemon) + 677 (shared)
- **Coverage**: ~85-90% overall for well-tested packages

---

## Notes

1. The shared package has excellent coverage for message-hub components (85-100%)
2. Some "unhandled error between tests" warnings appear during test runs - these may be expected error handling tests or test isolation issues
3. Online tests run separately and may have additional coverage considerations
4. The web package has excellent coverage in most areas (hooks 99%, SDK 94%, UI 97%)
5. The daemon package has good coverage for core functionality but gaps in room components and GitHub integration