# Plan: Improve kai Binary Configuration and Developer Experience

## Goal Overview

Improve the kai binary's configuration system to make local development, testing, and customization easier and more reliable.

## Key Issues to Address

1. **ANTHROPIC_BASE_URL not in Config interface** - The daemon's `Config` type doesn't include ANTHROPIC_BASE_URL. It's handled separately in provider-service.ts and applied at query time, making it invisible to configuration debugging.

2. **No CLI flags for configuration options** - The CLI only supports `--port`, `--workspace`, `--host`, and `--db-path`. Users cannot set API keys or base URLs via CLI for quick testing.

3. **No debug visibility** - There's no way to see what configuration is actually being used at startup.

4. **Provider env vars always override user settings** - The provider system always applies its own ANTHROPIC_BASE_URL, meaning even if a user sets it in settings.json, it gets overridden when making queries (except for Anthropic provider).

5. **Configuration precedence unclear** - While code has precedence (CLI > env > settings.json), it's not documented.

## Success Criteria

- ANTHROPIC_BASE_URL works reliably from environment variables and settings.json when using Anthropic provider
- Users can override configuration via CLI flags for quick testing
- Debug/logging shows which configuration sources are being used at startup
- Clear documentation on configuration precedence
- Easy to run kai against local/mock servers for development

---

## Task List

### Task 1: Add ANTHROPIC_BASE_URL to Config Interface and CLI Flags

**Description:**
- Add `anthropicBaseUrl` to the `Config` interface in `packages/daemon/src/config.ts`
- Add `anthropicBaseUrl`, `anthropicApiKey`, and `defaultModel` to `ConfigOverrides` interface
- Update `getConfig()` to read from:
  - CLI overrides first (passed via ConfigOverrides)
  - Then `process.env.ANTHROPIC_BASE_URL` if not overridden by CLI
- Add CLI flags in `packages/cli/src/cli-utils.ts`:
  - `--api-key` / `-k` for ANTHROPIC_API_KEY
  - `--base-url` for ANTHROPIC_BASE_URL
  - `--model` / `-m` for DEFAULT_MODEL
- Update CLI help text to document new flags
- Pass CLI overrides through to daemon via the existing override mechanism (ConfigOverrides)
- **Note on precedence**: Since credential-discovery runs at module load time (before CLI parses args), CLI flags will be passed as overrides to `getConfig()` and take precedence over environment variables

**Dependencies:** None

**Acceptance Criteria:**
- `kai --help` shows new CLI flags
- `ANTHROPIC_BASE_URL` is readable from `config.anthropicBaseUrl`
- CLI flags override environment variables via ConfigOverrides
- Changes must be on a feature branch with a GitHub PR created via `gh pr create`

**Agent Type:** coder

---

### Task 2: Add Configuration Debug Logging

**Description:**
- Add a `--debug-config` / `-d` flag to CLI
- When enabled, log at startup:
  - Which config sources are being used (CLI, env, settings.json, defaults)
  - The final configuration values (excluding sensitive values like API keys)
  - Configuration precedence for each value
- Create a new utility function `logConfigSources()` in `packages/daemon/src/lib/credential-discovery.ts` (more appropriate location than config.ts since it deals with config source discovery)
- Ensure API keys are redacted in logs (show only first 4 characters)
- Output should show: source of each config value (CLI flag, env var, settings.json, default)

**Dependencies:** Task 1 (uses CLI flags added in Task 1)

**Acceptance Criteria:**
- Running `kai -d` or `kai --debug-config` shows configuration debug output
- Sensitive values are redacted in logs
- Changes must be on a feature branch with a GitHub PR created via `gh pr create`

**Agent Type:** coder

---

### Task 3: Fix ANTHROPIC_BASE_URL Configuration for Anthropic Provider

**Description:**
- The issue is in `provider-service.ts` lines 361-367 where `getEnvVarsForModel()` returns `{}` for Anthropic provider
- Returning `{}` causes `clearProviderRoutingEnvVars()` to be called (line 421), which **deletes** the user's `ANTHROPIC_BASE_URL` from `process.env`
- **Implementation approach**: Modify `getEnvVarsForModel()` to return `{ ANTHROPIC_BASE_URL: process.env.ANTHROPIC_BASE_URL }` if the user has configured it and the provider is Anthropic
- This preserves user's configured URL instead of clearing it
- Ensure CLI/env overrides take precedence over settings.json for Anthropic provider
- The fix should be in `packages/daemon/src/lib/provider-service.ts` in the `getEnvVarsForModel()` method

**Dependencies:** Task 1

**Acceptance Criteria:**
- Setting `ANTHROPIC_BASE_URL` environment variable or CLI flag uses the custom URL for Anthropic provider
- The user's ANTHROPIC_BASE_URL is not deleted when making queries with Anthropic provider
- Changes must be on a feature branch with a GitHub PR created via `gh pr create`

**Agent Type:** coder

---

### Task 4: Document Configuration Precedence

**Description:**
- Create or update documentation explaining configuration precedence
- Document in:
  - CLI help text (update `getHelpText()` in cli-utils.ts)
  - A new section in `docs/configuration.md` or README
- Document the precedence order:
  1. CLI flags (highest priority) - passed as ConfigOverrides to getConfig()
  2. Environment variables (process.env)
  3. `~/.claude/settings.json` env block (applied at startup by credential-discovery)
  4. Defaults (lowest priority)
- Document special cases:
  - Provider-specific overrides (GLM, MiniMax always use their own base URLs)
  - ANTHROPIC_BASE_URL is now respected for Anthropic provider
- Include a table showing each config option and its source

**Dependencies:** Task 1, Task 3

**Acceptance Criteria:**
- CLI help shows configuration precedence summary
- Documentation file exists with complete configuration guide
- Changes must be on a feature branch with a GitHub PR created via `gh pr create`

**Agent Type:** coder

---

### Task 5: Add Unit Tests for Configuration System

**Description:**
- **Note**: `packages/daemon/tests/unit/config.test.ts` already exists - extend it with new tests
- Add unit tests:
  - Test `getConfig()` with various overrides (CLI overrides, env vars)
  - Test CLI flag parsing for new flags
  - Test configuration precedence (CLI > env > settings.json > defaults)
  - Test debug logging output
- Add tests for new ANTHROPIC_BASE_URL handling in provider-service.ts
- Ensure tests cover edge cases like:
  - CLI override vs env variable priority
  - Missing required configuration
  - Invalid configuration values
  - User's ANTHROPIC_BASE_URL being preserved for Anthropic provider

**Dependencies:** Task 1, Task 2, Task 3

**Acceptance Criteria:**
- Unit tests pass for all configuration scenarios
- Test coverage includes new configuration options
- Changes must be on a feature branch with a GitHub PR created via `gh pr create`

**Agent Type:** coder

---

## Dependencies Between Tasks

```
Task 1: Add ANTHROPIC_BASE_URL to Config Interface and CLI Flags
    |
    +-- Task 2: Add Configuration Debug Logging (depends on CLI flags)
    |
    +-- Task 3: Fix ANTHROPIC_BASE_URL Configuration (depends on Config changes)
    |
    +-- Task 4: Document Configuration Precedence (depends on Task 1, 3)
    |
    +-- Task 5: Add Unit Tests (depends on Task 1, 2, 3)
```

## Files to Modify

| File | Tasks |
|------|-------|
| `packages/daemon/src/config.ts` | 1, 3 |
| `packages/cli/src/cli-utils.ts` | 1, 2, 4 |
| `packages/cli/main.ts` | 1, 2 |
| `packages/daemon/src/lib/provider-service.ts` | 3 |
| `packages/daemon/src/lib/credential-discovery.ts` | 2 |
| `docs/configuration.md` (new) | 4 |
| `packages/daemon/tests/unit/config.test.ts` (extend) | 5 |
| `packages/cli/tests/cli-utils.test.ts` (if exists) | 5 |
