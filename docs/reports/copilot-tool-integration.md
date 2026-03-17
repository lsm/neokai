# GitHub Copilot CLI Tool Integration

**Date:** 2026-03-14

---

## Overview

This document describes how tool execution works with the Copilot CLI adapter and how
it integrates with NeoKai's tool system.

---

## Copilot CLI Tool Execution Model

### Built-in Tool Set

The Copilot CLI operates as an autonomous agent with its own built-in tools:

| Tool Category | Examples |
|--------------|----------|
| File operations | Read file, write file, patch file, list directory |
| Shell execution | Bash commands, script execution |
| GitHub API | PR create/read/comment, issue management, code search |
| Git operations | Checkout, branch, diff, blame, log |
| Web search | Documentation lookup, API reference |
| Code analysis | Static analysis, test running |

**Key behavior:** The CLI decides which tools to use based on the prompt. With `--allow-all`,
all tools execute without user confirmation.

### Direct Execution vs. Tool Call Returns

Unlike the legacy callback adapter (which calls back to NeoKai for tool execution), the Copilot CLI:
1. **Decides** which tool to use (internally)
2. **Executes** the tool immediately (e.g., writes a file to disk)
3. **Uses the result** to continue the response
4. **Optionally reports** tool calls in `assistant.message.toolRequests`

NeoKai never sees or approves individual tool calls — it receives only the final response.

---

## Tool Execution Callback Flow

### Legacy Callback-Based Approach
```
NeoKai            Legacy Adapter               LLM
  │──createQuery()──→ │                           │
  │                   │──messages──────────────→  │
  │                   │←────────────── tool_call─ │
  │←─tool_execution_* │                           │
  │──tool result─────→│                           │
  │                   │──tool_result──────────→   │
  │                   │←────────────── response─  │
  │←─SDKMessages─────│                           │
```

### Copilot CLI Approach (This Adapter)
```
NeoKai                     Copilot CLI Process
  │──spawn(prompt)──────→  │
  │                        │──tool calls (internal)──→ filesystem/gh API
  │                        │←─tool results ──────────
  │←─NDJSON stream─────── │
  │  (deltas + final msg)  │
  │←─process exit(0)────── │
```

**Implication:** NeoKai's tool permission system (accept/deny prompts) does NOT apply
to Copilot CLI tools. Use `--allow-all` for automation, or omit it for interactive use
(but that blocks the process waiting for user input).

---

## Mapping NeoKai Tools to Copilot CLI

### File Operations

| NeoKai Tool | Copilot CLI Equivalent |
|-------------|----------------------|
| `Read` (file) | CLI reads files via its internal file tool |
| `Write` (file) | CLI writes files directly to the filesystem |
| `Edit` (file) | CLI patches files via its edit/patch tool |
| `Glob` | CLI uses its file search tool |
| `Grep` | CLI uses its code search tool |

**Observation:** Since the CLI operates directly on the filesystem using the `cwd` parameter,
all file operations in NeoKai's worktree context work naturally.

### Shell Commands

| NeoKai Tool | Copilot CLI Equivalent |
|-------------|----------------------|
| `Bash` | CLI's built-in bash/shell tool |

### GitHub API Integration

The Copilot CLI has native GitHub API tools that are NOT available in the legacy callback adapter:

| Copilot CLI Tool | GitHub Operation |
|-----------------|-----------------|
| PR read | `gh pr view <number>` |
| PR comment | `gh pr comment <number> --body "..."` |
| PR review | `gh pr review <number> --approve/--request-changes` |
| Issue read | `gh issue view <number>` |
| Issue comment | `gh issue comment <number> --body "..."` |
| Code search | GitHub Copilot's code search API |

**These are all handled autonomously** — the CLI calls GitHub API as needed based on
the prompt context.

### MCP Tools

MCP tools cannot be directly exposed to the Copilot CLI. However:
- The CLI can call MCP servers as plugins (via `copilot plugin`)
- Custom plugins can bridge NeoKai MCP tools to Copilot
- In the POC, MCP tools are not forwarded

---

## Authentication for GitHub API Operations

The CLI uses the same GitHub token for both authentication and GitHub API calls:
- `COPILOT_GITHUB_TOKEN` → Copilot API calls + GitHub API
- `GH_TOKEN` / `GITHUB_TOKEN` → Same
- Stored credentials (from `copilot login` or `gh auth`) → Same

The token requires:
- `repo` scope for private repository access
- `read:org` for organization operations
- `workflow` for CI/CD operations

**NeoKai integration:** Pass the authenticated token via `COPILOT_GITHUB_TOKEN` env var
when spawning the process.

---

## Security Boundaries

### Important Security Considerations

1. **Arbitrary code execution:** With `--allow-all`, the CLI can run ANY shell command.
   Only safe to use in:
   - Isolated worktrees (git worktree isolation)
   - Container/VM environments
   - Trusted automation contexts

2. **Filesystem access:** The CLI can read/write any file accessible to the current user.
   Working directory (`--cwd`) limits the starting scope but does NOT sandbox the CLI.

3. **GitHub token scope:** The token passed to the CLI can be used for all GitHub operations
   the token grants access to — including destructive operations (force push, delete branches).

4. **Network access:** The CLI can make arbitrary HTTP requests via its shell/bash tool.

### Recommended Safeguards
- Use `--cwd <worktree_path>` to scope initial context
- Use a GitHub token with minimal required scopes
- Run in a container or VM for full isolation
- Log subprocess stdout/stderr for audit trail
- Set a timeout on the subprocess to prevent runaway agents

---

## Parallel Tool Execution

The Copilot CLI supports parallel subagents via `/fleet`. In non-interactive mode,
tool parallelism is handled internally by the CLI. NeoKai does not need to coordinate
parallel tool calls.

---

## Practical Example: Copilot CLI Processing a NeoKai Task

Given a NeoKai task: "Fix the authentication bug in auth.ts and add tests"

1. NeoKai spawns: `copilot -p "Fix the authentication bug in auth.ts and add tests" --allow-all --output-format json --cwd /path/to/worktree`

2. Copilot CLI internally:
   - Reads `auth.ts` using its file read tool
   - Analyzes the code
   - Identifies the bug
   - Uses its edit/patch tool to fix it
   - Writes the fix to disk
   - Reads existing test files
   - Writes new tests
   - Possibly runs `bun test` to verify

3. NeoKai receives:
   - Streaming text deltas describing what was done
   - Final `SDKAssistantMessage` with the complete response
   - `SDKResultMessage` with success/failure

4. Files are actually modified on disk — NeoKai doesn't need to apply patches separately.

**This is fundamentally different from the legacy callback adapter:** The CLI is a complete
agent that delivers results, not just API calls that NeoKai must orchestrate.
