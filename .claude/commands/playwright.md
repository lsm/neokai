---
name: playwright
description: CLI-first browser automation using Playwright
---

# Playwright Browser Automation

Use `bunx @playwright/cli` for terminal-driven browser automation. This skill is for automating web browsers — scraping, UI interaction, form filling, navigation, and screenshot capture. It is NOT for running end-to-end test suites.

## Core workflow

1. **Open a page** — navigate to the target URL
2. **Snapshot** — capture the accessibility tree to identify interactive elements
3. **Interact** — click, fill, type, or press using element refs from the snapshot
4. **Re-snapshot** — always re-snapshot after interactions; refs go stale after DOM changes

## Essential commands

```bash
# Navigate to a URL
bunx @playwright/cli open <url>

# Capture accessibility snapshot (returns element refs like "e15", "e42")
bunx @playwright/cli snapshot

# Click an element by its ref
bunx @playwright/cli click <ref>

# Fill an input field
bunx @playwright/cli fill <ref> "<value>"

# Type text character by character (for inputs that react to each keypress)
bunx @playwright/cli type <ref> "<value>"

# Press a key
bunx @playwright/cli press <ref> <key>

# Take a screenshot (saves to file)
bunx @playwright/cli screenshot <path>

# Open a new browser tab
bunx @playwright/cli tab-new <url>

# List all open tabs
bunx @playwright/cli tab-list

# Switch to a tab by index
bunx @playwright/cli tab-select <index>

# Start recording a trace
bunx @playwright/cli tracing-start

# Stop recording and save the trace
bunx @playwright/cli tracing-stop <path>
```

## Guardrails

- **Always snapshot before using element refs.** Refs like `e15` are session-scoped and only valid after a snapshot.
- **Re-snapshot after every interaction.** DOM mutations invalidate existing refs. If a click triggers a page update, run `snapshot` again before the next interaction.
- **Prefer CLI over `eval` or code execution.** Use the CLI commands above instead of writing Playwright scripts unless the CLI cannot express what you need.
- **Use `fill` for form inputs, not `type`**, unless the field listens to individual keydown events.
- **Check the snapshot for aria roles and labels** to pick the right element ref — don't guess by index.

## Typical automation flow

```bash
# 1. Open the page
bunx @playwright/cli open https://example.com/login

# 2. Snapshot to see available elements
bunx @playwright/cli snapshot
# Output includes refs: e1 (heading "Sign in"), e5 (input[name=email]), e6 (input[name=password]), e8 (button "Log in")

# 3. Fill the login form
bunx @playwright/cli fill e5 "user@example.com"
bunx @playwright/cli fill e6 "hunter2"

# 4. Submit
bunx @playwright/cli click e8

# 5. Re-snapshot to verify the result
bunx @playwright/cli snapshot

# 6. Take a screenshot as evidence
bunx @playwright/cli screenshot /tmp/after-login.png
```

## Multi-tab workflows

```bash
# Open a second tab
bunx @playwright/cli tab-new https://example.com/dashboard

# List tabs to find the index
bunx @playwright/cli tab-list

# Switch back to the first tab (index 0)
bunx @playwright/cli tab-select 0
```

## Tracing

Use tracing to record a full interaction trace for debugging:

```bash
bunx @playwright/cli tracing-start
# ... perform interactions ...
bunx @playwright/cli tracing-stop /tmp/trace.zip
```

Open the trace with:
```bash
bunx playwright show-trace /tmp/trace.zip
```

## Notes

- Headless mode is the default. The browser window is not visible.
- If a page requires JavaScript rendering, `open` waits for `load` before returning.
- For pages that dynamically load content after scroll, snapshot may not capture below-the-fold elements until you scroll.
