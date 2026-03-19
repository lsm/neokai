# Anthropic-Copilot Provider Setup

This document covers how to configure the `anthropic-copilot` provider in NeoKai, which bridges to GitHub Copilot as an Anthropic-compatible API.

## Overview

The `anthropic-copilot` provider exposes GitHub Copilot as an Anthropic-compatible API endpoint. This allows NeoKai to use Copilot models (like `claude-sonnet-4-20250514`, `claude-opus-4-20250514`, etc.) through the standard Anthropic API interface.

### What It Does

- Exposes Copilot models via an Anthropic-shaped `/v1/messages` endpoint
- Bridges tool-use/tool-result calls to Copilot's native tool system
- Supports streaming responses via Server-Sent Events (SSE)

### Provider Capability Flags

| Capability | `anthropic` | `anthropic-copilot` |
|------------|-------------|---------------------|
| Streaming | ✅ | ✅ |
| Function Calling | ✅ | ✅ |
| Vision | ✅ | ❌ |
| Extended Thinking | ✅ | ❌ |

---

## Authentication Methods

The provider discovers GitHub credentials in the following order:

1. **NeoKai OAuth** — If you've logged in via Claude Code OAuth (handled automatically)
2. **`COPILOT_GITHUB_TOKEN`** — Environment variable with a PAT (Personal Access Token)
3. **`GH_TOKEN`** — Environment variable (fallback)
4. **`gh auth token`** — CLI command output
5. **`~/.config/gh/hosts.yml`** — OAuth token from GitHub CLI configuration

> **Important:** The `GITHUB_TOKEN` environment variable (used by GitHub Actions) is **NOT** used — it lacks the required `copilot_requests` scope.

### Option 1: NeoKai OAuth (Recommended for Claude Code Users)

If you're already logged into Claude Code, NeoKai automatically uses your Claude Code OAuth token for Copilot. No additional configuration needed.

### Option 2: COPILOT_GITHUB_TOKEN Environment Variable

Set a Personal Access Token (PAT) with the `copilot_requests` scope:

```bash
# In your shell or .env file
export COPILOT_GITHUB_TOKEN=ghp_your_token_here
```

To create a PAT:
1. Go to GitHub Settings → Developer settings → Personal access tokens → Fine-grained tokens
2. Generate new token with:
   - Repository access: All repositories
   - Permissions: Copilot (Access: read/write)

### Option 3: GH_TOKEN Environment Variable

If you have a GitHub token already set in your environment:

```bash
export GH_TOKEN=ghp_your_token_here
```

### Option 4: gh auth login

If you have the GitHub CLI installed and authenticated:

```bash
gh auth login
```

The provider will use `gh auth token` to retrieve your authentication token.

### Option 5: ~/.config/gh/hosts.yml

If you've authenticated via GitHub CLI, your OAuth token is stored in `~/.config/gh/hosts.yml`. The provider automatically reads the `oauth_token` from this file.

---

## Step-by-Step Setup

### Step 1: Choose Your Authentication Method

For most users, **Option 1 (NeoKai OAuth)** works automatically if you're logged into Claude Code.

If you need to configure manually:

### Option A: Using a PAT

1. Create a Personal Access Token with `copilot_requests` scope (see Option 2 above)
2. Add to your environment:

```bash
# Add to ~/.env or export in shell
COPILOT_GITHUB_TOKEN=ghp_your_token_here
```

### Option B: Using GitHub CLI

1. Install GitHub CLI if not installed: `brew install gh`
2. Authenticate: `gh auth login`
3. Ensure Copilot is enabled in your GitHub account settings

### Step 2: Verify Configuration

Start NeoKai and check the provider status in the UI. You should see Copilot models available when:
- The provider indicator shows green (authenticated)
- Copilot models appear in the model picker

---

## Troubleshooting

### Classic PAT Rejection

**Symptom:** Authentication fails with error: "Invalid authentication credentials"

**Cause:** Your PAT may lack the required `copilot_requests` scope, or the token has expired.

**Solution:**
1. Go to GitHub Settings → Developer settings → Personal access tokens
2. Ensure your token has the `copilot_requests` scope enabled
3. Regenerate the token if expired
4. Update `COPILOT_GITHUB_TOKEN` with the new token

### Token Validation Failures

**Symptom:** "Token validation failed" or similar authentication error

**Cause:** Tokens obtained via `gh auth token` or `~/.config/gh/hosts.yml` are OAuth tokens that must be exchanged for a Copilot session token.

**Solution:**
- The provider automatically performs this exchange for tokens from sources 4 and 5
- If you're using a PAT directly (source 2), ensure it has the correct scope
- For enterprise GitHub accounts, ensure Copilot is enabled in your organization

### Enterprise GitHub

**Symptom:** Authentication works but returns no models or "Copilot not enabled"

**Cause:** Your GitHub Enterprise organization may have Copilot disabled or require additional permissions.

**Solution:**
1. Contact your organization admin to enable Copilot
2. Ensure you have Copilot access granted in your organization settings
3. For enterprise-managed users, you may need to use a PAT with organization-specific scopes

### Linux Specific: Node.js Version

**Symptom:** Provider fails to start on Linux with "node:sqlite" module error

**Cause:** The Copilot CLI subprocess requires Node.js >= 22.5.0 with `node:sqlite` support.

**Solution:**
- On Linux, ensure Node.js 22 LTS or Node.js 24 is installed and available on PATH
- On macOS, this is handled automatically by Bun

---

## Known Limitations

### No Vision Support

The Copilot bridge does **not** support image input or multimodal content. Attempting to send images will result in an error.

### No Extended Thinking

Extended thinking (thinking blocks in API responses) is not supported by Copilot and therefore not available through this bridge.

### Heuristic Token Counting

Token usage (`input_tokens`, `output_tokens`) is estimated based on character count (1 token ≈ 4 characters) rather than actual counts from Copilot. This is due to SDK limitations.

### tool_choice Limitations

The `tool_choice` parameter is accepted for API compatibility but is **not honored** by the Copilot bridge. The model will decide which tool to use regardless of the parameter value.

### Request Parameter Restrictions

The following Anthropic API parameters are not forwarded to Copilot:
- `temperature`, `top_p`, `top_k`
- `stop_sequences`
- Advanced sampling controls

### Non-Streaming Not Supported

The bridge requires `stream=true`. Requests with `stream=false` will receive a 400 error.
