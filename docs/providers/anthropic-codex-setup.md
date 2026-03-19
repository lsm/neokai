# Anthropic-Codex Provider Setup

This document covers how to configure the `anthropic-codex` provider in NeoKai, which bridges to OpenAI Codex as an Anthropic-compatible API.

## Overview

The `anthropic-codex` provider exposes OpenAI Codex as an Anthropic-compatible API endpoint. This allows NeoKai to use Codex models (like `claude-3-5-sonnet-20241022`, etc.) through the standard Anthropic API interface.

### What It Does

- Exposes Codex models via an Anthropic-shaped `/v1/messages` endpoint
- Bridges tool-use/tool-result calls to Codex's native tool system
- Supports streaming responses via Server-Sent Events (SSE)
- Uses the Codex CLI (`codex`) as the underlying runtime

### Provider Capability Flags

| Capability | `anthropic` | `anthropic-codex` |
|------------|-------------|-------------------|
| Streaming | ✅ | ✅ |
| Function Calling | ✅ | ✅ |
| Vision | ✅ | ❌ |
| Extended Thinking | ✅ | ❌ |

---

## Prerequisites

### Codex CLI Must Be on PATH

The Codex provider requires the `codex` CLI to be installed and available on your system PATH.

**Installation:**

1. Download Codex CLI from [https://openai.com/codex](https://openai.com/codex)
2. Follow the installation instructions for your platform
3. Verify installation:

```bash
codex --version
```

If `codex` is not found on PATH, NeoKai will display an error: "codex binary not found on PATH. Install Codex CLI to use this provider."

---

## Authentication Methods

The provider discovers Codex/OpenAI credentials in the following order:

1. **`OPENAI_API_KEY`** — Environment variable
2. **`CODEX_API_KEY`** — Environment variable (Codex-specific)
3. **NeoKai OAuth** — Login via Claude Code (ChatGPT Plus/Pro)
4. **Legacy migration** — Tokens from `~/.codex/auth.json` (users who previously ran `codex login`)

### Option 1: OPENAI_API_KEY

Set your OpenAI API key directly:

```bash
# In your shell or .env file
export OPENAI_API_KEY=sk-your-key-here
```

### Option 2: CODEX_API_KEY

Use the Codex-specific API key:

```bash
# In your shell or .env file
export CODEX_API_KEY=codex-your-key-here
```

### Option 3: NeoKai OAuth (ChatGPT Plus/Pro)

If you have a ChatGPT Plus or Pro subscription:
1. Log in through NeoKai's authentication flow
2. Your ChatGPT subscription credentials are used automatically

### Option 4: Legacy codex login Migration

Users who previously ran `codex login` have their credentials stored in `~/.codex/auth.json`. NeoKai automatically imports these credentials once into `~/.neokai/auth.json` for first-time use.

> **Note:** For new users, we recommend using `OPENAI_API_KEY` or `CODEX_API_KEY` directly rather than the legacy migration path.

---

## Step-by-Step Setup

### Step 1: Install Codex CLI

Download and install the Codex CLI from [https://openai.com/codex](https://openai.com/codex)

Verify installation:
```bash
codex --version
```

### Step 2: Configure Authentication

Choose one of the authentication methods above:

#### Option A: Using OPENAI_API_KEY

```bash
# Add to ~/.env or export in shell
OPENAI_API_KEY=sk-your-openai-key
```

#### Option B: Using CODEX_API_KEY

```bash
# Add to ~/.env or export in shell
CODEX_API_KEY=your-codex-key
```

#### Option C: Using NeoKai OAuth

1. Open NeoKai in your browser
2. Navigate to Settings → Authentication
3. Log in with your ChatGPT account (Plus or Pro required)

### Step 3: Verify Configuration

Start NeoKai and check the provider status in the UI. You should see Codex models available when:
- The provider indicator shows green (authenticated)
- Codex models appear in the model picker

---

## Troubleshooting

### Codex Binary Not Found

**Symptom:** Error message: "codex binary not found on PATH. Install Codex CLI to use this provider."

**Cause:** The `codex` CLI is not installed or not available on your system PATH.

**Solution:**
1. Download Codex CLI from [https://openai.com/codex](https://openai.com/codex)
2. Follow the installation instructions for your platform
3. Ensure the `codex` command is available in your terminal:

```bash
codex --version
```

If installed but not found, add the Codex installation directory to your PATH.

### OAuth Token Refresh

**Symptom:** Authentication was working but now fails with "Invalid credentials" or "Token expired"

**Cause:** OAuth tokens (from NeoKai OAuth or ChatGPT login) may expire over time.

**Solution:**
1. Re-authenticate through NeoKai's authentication flow
2. For ChatGPT Plus/Pro: Log out and log back in through Settings → Authentication

### Workspace Isolation

**Symptom:** Codex fails with permission errors or cannot access files

**Cause:** Codex requires access to the workspace directory for file operations.

**Solution:**
1. Ensure you're running NeoKai from a directory where Codex has read/write permissions
2. Check that the workspace path doesn't contain special characters or symlinks that may confuse Codex
3. For enterprise deployments, ensure Codex is configured with appropriate workspace access

### API Key Not Recognized

**Symptom:** "Invalid API key" error despite setting OPENAI_API_KEY

**Solution:**
1. Verify the key is set correctly:
   ```bash
   echo $OPENAI_API_KEY
   ```
2. Ensure there are no extra spaces or quotes in your environment variable
3. Check that you're using a valid API key from [https://platform.openai.com/api-keys](https://platform.openai.com/api-keys)
4. For Codex-specific keys, use `CODEX_API_KEY` instead

---

## Known Limitations

### No Vision Support

The Codex bridge does **not** support image input or multimodal content. Attempting to send images will result in an error.

### No Extended Thinking

Extended thinking (thinking blocks in API responses) is not supported by Codex and therefore not available through this bridge.

### Heuristic Token Counting

Token usage (`input_tokens`, `output_tokens`) is estimated based on character count (1 token ≈ 4 characters) by default, unless actual usage data is wired through from the Codex CLI's `thread/tokenUsage/updated` notifications.

### Text-Flattened Conversation Semantics

The Codex bridge flattens the full block-structured Anthropic conversation to plain text rather than preserving the structured message format. This means:
- Multi-message conversations are converted to a single text prompt
- Role information is preserved through prefixes (e.g., "Human:", "Assistant:")
- Some semantic nuances of structured messages may be lost

### Single-Tool-Result Limitation

When providing multiple tool results in a single continuation request, the Codex bridge currently uses only the first tool result (`toolResults[0]`). Additional tool results in the same response are not processed.

### tool_choice Not Supported

The `tool_choice` parameter is accepted for API compatibility but is **not honored** by the Codex bridge. The model will decide which tool to use regardless of the parameter value.

### Request Parameter Restrictions

The following Anthropic API parameters are not forwarded to Codex:
- `temperature`, `top_p`, `top_k`
- `stop_sequences`
- `metadata`
- Advanced sampling controls

### Non-Streaming Not Supported

The bridge requires `stream=true`. Requests with `stream=false` will receive a 400 error, though the response will still be delivered as SSE.
