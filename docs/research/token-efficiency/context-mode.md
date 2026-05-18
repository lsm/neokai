# Stop Burning Your Context Window — We Built Context Mode

**Author:** Mert Köseoğlu  
**Date:** Feb 26, 2026  
**Source:** https://mksg.lu/blog/context-mode

## Summary

Context Mode is an MCP server designed to cut Claude Code context usage by routing tool output through an isolated sandbox. The article claims:

> "315 KB becomes 5.4 KB."

It says this produces a **98% reduction** in context consumption by preventing raw tool data from being added directly to the conversation.

## The Problem

The article argues that MCP tool use creates a two-sided context burden:

- **Tool definitions** consume context before the first user message.
- **Tool outputs** then keep filling the window during use.

Examples given include:

- A Playwright snapshot: **56 KB**
- Twenty GitHub issues: **59 KB**
- One access log: **45 KB**

The post says that after about 30 minutes, **40% of context** may already be gone.

It also notes that with **81+ active tools**, **143K tokens** are consumed up front, or **72%** of the 200K context window.

## How the Sandbox Works

Context Mode’s `execute` call runs code in an **isolated subprocess**:

- Each call has its own process boundary.
- Scripts cannot access each other’s memory or state.
- Only **stdout** is returned to the conversation.
- Raw artifacts such as logs, API responses, and snapshots remain outside context.

### Supported runtimes

The article lists ten available runtimes:

- JavaScript
- TypeScript
- Python
- Shell
- Ruby
- Go
- Rust
- PHP
- Perl
- R

It also says **Bun** is auto-detected for faster JS/TS execution, with a claimed **3–5x speedup**.

### Authenticated CLIs

The sandbox supports credential passthrough for:

- `gh`
- `aws`
- `gcloud`
- `kubectl`
- `docker`

The subprocess inherits environment variables and config paths without exposing them to the conversation.

## How the Knowledge Base Works

The `index` tool:

- splits markdown by headings,
- keeps code blocks intact,
- stores content in a **SQLite FTS5** virtual table.

Search uses:

- **BM25 ranking**
- **Porter stemming** at index time

This means words like “running,” “runs,” and “ran” are matched through stemming.

### Search and indexing behavior

- `search` returns the **actual indexed content**
- It includes the **heading hierarchy**
- It does **not** return summaries
- `fetch_and_index` can ingest URLs by:
  - fetching the page,
  - converting HTML to markdown,
  - chunking,
  - indexing it

The article says the **raw page never enters context**.

## Benchmark Numbers

The post says the system was validated across **11 real-world scenarios**, including:

- test triage
- TypeScript error diagnosis
- git diff review
- dependency audit
- API response processing
- CSV analytics

It claims all outputs stayed under **1 KB**.

### Reported reductions

- Playwright snapshot: **56 KB → 299 B**
- GitHub issues (20): **59 KB → 1.1 KB**
- Access log (500 requests): **45 KB → 155 B**
- Analytics CSV (500 rows): **85 KB → 222 B**
- Git log (153 commits): **11.6 KB → 107 B**
- Repo research (subagent): **986 KB → 62 KB**  
  - **5 calls vs 37**

### Session-level result

The article states:

- **315 KB** raw output → **5.4 KB**
- session time before slowdown: **~30 minutes → ~3 hours**
- context remaining after 45 minutes: **99% instead of 60%**

## Installation

### Plugin Marketplace

The article provides:

```bash
/plugin marketplace add mksglu/claude-context-mode
/plugin install context-mode@claude-context-mode
```

### MCP-only install

```bash
claude mcp add context-mode -- npx -y context-mode
```

Then restart Claude Code.

## What Changes in Practice

The post says the workflow itself does not change, because:

- a **PreToolUse hook** routes outputs through the sandbox automatically,
- subagents are encouraged to use `batch_execute`,
- Bash subagents are upgraded to `general-purpose` so they can use MCP tools.

The claimed effect is that the context window stops filling up as quickly, extending usable session time.

## Why It Was Built

The author says he runs the **MCP Directory & Hub**, which gets **100K+ daily requests**, and noticed a common pattern:

- many tools dump raw output into context,
- few address the output side of context usage.

He says Cloudflare’s Code Mode inspired the approach, but in the opposite direction:

- Cloudflare compressed tool definitions,
- Context Mode compresses tool outputs.

He also says it was first built for his own Claude Code use, where it reportedly allowed work **6x longer** before context degradation.

## Repository and Source Links

- GitHub repo: https://github.com/mksglu/claude-context-mode
- LinkedIn: https://www.linkedin.com/in/mksglu
- X: https://x.com/mksglu
- Personal site: https://mksg.lu

## License

The article says the project is **Open source. MIT.**
