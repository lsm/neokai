# GitHub Copilot CLI vs. Pi-Mono Adapter: Comparison & Recommendation

**Date:** 2026-03-14

---

## Executive Summary

**Recommendation: Keep pi-mono adapter as primary; add Copilot CLI as supplementary provider.**

The Copilot CLI is a fundamentally different approach from the pi-mono adapter — it's an
autonomous agent rather than an API proxy. For NeoKai's primary use case (transparent
multi-provider API access with tool interception), pi-mono remains the better choice after
its tool use issues are fixed. The Copilot CLI excels for specific use cases: autonomous
coding tasks, PR review with native GitHub context, and model diversity without API key management.

---

## Architectural Comparison

| Dimension | Pi-Mono Adapter | Copilot CLI Adapter |
|-----------|----------------|---------------------|
| **Approach** | API proxy with tool callbacks | Autonomous agent subprocess |
| **Tool execution** | NeoKai executes tools via callbacks | CLI executes tools autonomously |
| **Tool interception** | ✅ Full control | ❌ None (black box) |
| **Streaming** | ✅ Token-level deltas via SSE | ✅ Token-level deltas via NDJSON |
| **Multi-turn** | ✅ Managed by pi-agent-core | 🔶 Via `--resume <sessionId>` |
| **System prompt** | ✅ Full control | 🔶 Prepended to prompt |
| **Tool definitions** | ✅ NeoKai tools forwarded | ❌ CLI's own tools only |
| **Model selection** | ✅ Any model in pi-ai registry | ✅ 15+ models via `--model` flag |
| **MCP tools** | ✅ Via NeoKai tool forwarding | ❌ Not supported |
| **Cost reporting** | ✅ Token counts + USD cost | ❌ Only premiumRequests count |
| **Permission mode** | ✅ NeoKai handles accept/deny | 🔶 `--allow-all` only in automation |
| **Observability** | ✅ Full message visibility | ❌ Black box tool execution |
| **Binary dependency** | ❌ npm packages only | ✅ Requires `copilot` binary |
| **GitHub integration** | 🔶 Via NeoKai tools | ✅ Native (PR, issues, code search) |

---

## Feature Parity Analysis

### Streaming
Both approaches support token-level streaming.
- **Pi-mono:** SSE via pi-agent-core Agent events (`message_update` → `text_delta`)
- **CLI:** NDJSON `assistant.message_delta` events → mapped to `stream_event`

**Winner: Tie** (both work, different protocols)

### Tool Use (Critical Issue Area)
The task context states "pi-mono path is not working correctly, especially tool use."

- **Pi-mono issues:**
  - Tool schema translation (TypeBox `Record(String, Any)` loses specificity)
  - Multi-turn tool result injection may have race conditions
  - Model-specific tool calling differences (GPT-5 vs Claude have different formats)

- **CLI approach:**
  - No tool use issues — CLI handles everything internally
  - NeoKai's tools (MCP, custom) cannot be used
  - Good for tasks where the CLI's built-in tools are sufficient

**Winner: CLI** (for reliable execution) / **Pi-mono** (for NeoKai tool integration)

### Multi-Turn Conversations
- **Pi-mono:** Agents handle multi-turn via the Agent class (automatic tool result injection)
- **CLI:** Single invocation with `--resume` for follow-up messages

**Winner: Pi-mono** (seamless multi-turn within one session)

### Error Handling
- **Pi-mono:** Structured errors via `state.agentError`, maps to `SDKResultMessage`
- **CLI:** Exit code + stderr capture, limited error detail

**Winner: Pi-mono** (richer error information)

### Reliability
- **Pi-mono:** Depends on pi-ai/pi-agent-core package stability, token exchange complexity
- **CLI:** Depends on binary availability, CLI updates may break compatibility

**Winner: Tie** (both have dependency risks)

### Maintenance Burden
- **Pi-mono:** Must track pi-ai API changes, model registry updates, token formats
- **CLI:** Binary updates (use `--no-auto-update` + pin version), NDJSON format changes

**Winner: CLI** (less in-house maintenance)

### GitHub API Integration
- **Pi-mono:** NeoKai must implement gh CLI calls as tools
- **CLI:** Native GitHub integration (PR review, comments, issues, code search)

**Winner: CLI** (superior GitHub integration)

---

## Performance Characteristics

### Latency
| Scenario | Pi-Mono | Copilot CLI |
|----------|---------|-------------|
| First token | ~300ms (HTTP SSE) | ~800ms (subprocess spawn + CLI init) |
| Tool execution round-trip | ~200ms per tool | N/A (internal to CLI) |
| Total task completion | Similar | Similar |

**Note:** The CLI subprocess startup adds ~500ms per invocation. For long-running tasks,
this overhead is negligible.

### Throughput
Both approaches are limited by the API rate limits of the underlying provider. The Copilot
CLI may have lower per-user rate limits compared to direct API access.

---

## When to Use Each Approach

### Use Pi-Mono Adapter When:
- NeoKai tools (MCP, custom tools) must be available to the model
- Full tool interception and permission control is required
- Cost tracking (USD) is important
- Fine-grained conversation history control is needed
- Running in environments without the Copilot CLI binary

### Use Copilot CLI Adapter When:
- GitHub-native tasks: PR review, issue triage, code search
- Autonomous coding tasks where built-in tools are sufficient
- Model diversity without separate API key management (GPT-5.3-codex, Gemini 3)
- Running as a "reviewer" sub-agent that doesn't need NeoKai tools
- Users have GitHub Copilot access but not OpenAI/Anthropic API keys

---

## Migration Path (If Full Adoption Recommended)

1. **Phase 1 (Current - POC):** CLI adapter as optional secondary provider
   - `github-copilot-cli` provider ID
   - Works alongside existing `github-copilot` (pi-mono)
   - Used for PR review sub-agents

2. **Phase 2 (If Tool Issue Fixed):** Pi-mono as primary
   - Fix tool use in pi-mono adapter (using correct layer)
   - Keep CLI as supplementary for GitHub-native tasks

3. **Phase 3 (If CLI Matures):** Consider ACP mode
   - Replace NDJSON subprocess with JSON-RPC 2.0 ACP client
   - Use `github/copilot-sdk` for structured communication
   - Enables tool permission callbacks in interactive mode

**Full replacement of pi-mono with CLI is NOT recommended** due to:
1. Loss of NeoKai tool interception
2. Loss of cost tracking
3. Binary dependency
4. Reduced observability

---

## Open Questions (Addressed)

| Question | Answer |
|----------|--------|
| Programmatic/automated usage? | ✅ Yes — `--output-format json --allow-all --no-auto-update` |
| Long-lived daemon or spawn per query? | Spawn per query in NDJSON mode; ACP mode enables daemon |
| Git context detection? | ✅ Automatic when `--cwd` points to a git repo |
| Rate limits? | Copilot premium requests quota; details not publicly documented |
| Private repositories? | ✅ Yes, with `repo` scope on the token |
| Backward compatibility on update? | Use `--no-auto-update` and pin version for stability |
| Works without git? | ✅ Yes — file/shell tools work without git context |

---

## Final Recommendation

**Adopt Copilot CLI adapter as a supplementary provider for GitHub-native tasks, while
fixing pi-mono for the primary multi-provider use case.**

1. **Fix pi-mono first** — The root issue is in tool use layer selection (use the higher-level
   coding agent package, not the raw API). This enables the original goal of transparent
   multi-provider support with full NeoKai tool integration.

2. **Add Copilot CLI as a second option** — For the specific use case of PR review with
   GitHub-native context (Copilot's GitHub integration is superior to calling gh CLI via tools).

3. **Do NOT use Copilot CLI as a replacement for pi-mono** — The loss of tool interception
   means NeoKai cannot use its MCP tools, custom tools, or permission system.

4. **Future: Explore ACP mode** — When `github/copilot-sdk` matures, ACP mode could
   enable permission callbacks, making the CLI approach more viable as a full replacement.
