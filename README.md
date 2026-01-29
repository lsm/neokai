# Liuboer Core

[![CI](https://github.com/lsm/liuboer-core/actions/workflows/package-tests.yml/badge.svg)](https://github.com/lsm/liuboer-core/actions/workflows/package-tests.yml)
[![E2E](https://github.com/lsm/liuboer-core/actions/workflows/e2e-quick.yml/badge.svg)](https://github.com/lsm/liuboer-core/actions/workflows/e2e-quick.yml)
[![codecov](https://codecov.io/gh/lsm/liuboer-core/graph/badge.svg)](https://codecov.io/gh/lsm/liuboer-core)

Web-based interface for Claude Agent SDK, enabling multi-session agent conversations.

## Coverage

| Package | Coverage |
|---------|----------|
| Daemon | [![daemon](https://codecov.io/gh/lsm/liuboer-core/graph/badge.svg?flag=daemon)](https://codecov.io/gh/lsm/liuboer-core?flags[0]=daemon) |
| Web | [![web](https://codecov.io/gh/lsm/liuboer-core/graph/badge.svg?flag=web)](https://codecov.io/gh/lsm/liuboer-core?flags[0]=web) |
| E2E | [![e2e](https://codecov.io/gh/lsm/liuboer-core/graph/badge.svg?flag=e2e-matrix)](https://codecov.io/gh/lsm/liuboer-core?flags[0]=e2e-matrix) |

## Packages

| Package | Description |
|---------|-------------|
| `@liuboer/cli` | Unified server (daemon + web) |
| `@liuboer/daemon` | Backend wrapping Claude Agent SDK |
| `@liuboer/web` | Preact + Signals UI |
| `@liuboer/shared` | Types, MessageHub, utilities |
| `@liuboer/e2e` | End-to-end tests |

## Installation

```bash
bun install
```

## Development

```bash
make dev          # Start dev server (port 9283)
make self         # Use liuboer to develop liuboer :)
make typecheck    # Type check
make lint         # Lint code
```

## Testing

```bash
# Unit tests
bun run test:daemon     # Daemon tests
bun run test:web        # Web tests (vitest)
bun run test:shared     # Shared tests

# E2E tests
bun run test:e2e        # All E2E tests
```
