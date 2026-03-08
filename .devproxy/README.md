# Dev Proxy Mock Files

This directory contains mock response files for the NeoKai test suite. These files are used by Dev Proxy to simulate Anthropic API responses without making real API calls.

## Quick Start

```bash
# Start Dev Proxy with default mocks
bun run test:proxy:start

# Set environment for tests
export HTTPS_PROXY=http://127.0.0.1:8000
export HTTP_PROXY=http://127.0.0.1:8000
export NODE_USE_ENV_PROXY=1
export NODE_EXTRA_CA_CERTS=~/.proxy/rootCA.pem

# Run tests
NEOKAI_TEST_ONLINE=true bun test packages/daemon/tests/online/
```

## Mock Files

| File | Description | Use Case |
|------|-------------|----------|
| `mocks.json` | Default mock responses | General testing |
| `mocks-basic.json` | Simple text responses | Basic conversation tests |
| `mocks-tool-use.json` | Tool call scenarios | Tool execution tests |
| `mocks-errors.json` | Error responses | Error handling tests |
| `mocks-room.json` | Multi-agent scenarios | Room workflow tests |

## Switching Mock Files

Edit `devproxyrc.json`:

```json
{
  "mockResponsePlugin": {
    "mocksFile": "mocks-tool-use.json"
  }
}
```

Then restart Dev Proxy:

```bash
bun run test:proxy:restart
```

## Scenario Coverage

### mocks-basic.json

| Trigger | Response |
|---------|----------|
| Default | Generic greeting message |
| "What is 2+2?..." | "4" |
| "What is 1+1?..." | "2" |
| "What is 3+3?..." | "6" |
| "Say hello" | Greeting response |
| "Tell me a joke" | Programmer joke |
| "room ok" | Room chat acknowledgment |

### mocks-tool-use.json

| Trigger | Tool | Action |
|---------|------|--------|
| "Read the file test.txt" | Read | File read operation |
| "Write a file called output.txt..." | Write | File write operation |
| "List files in the current directory" | Glob | File listing |
| "Search for TODO in all files" | Grep | Content search |
| "Run the command echo hello" | Bash | Command execution |
| "What is git status?" | Bash | Git status check |
| "Call the MCP tool to create a task" | mcp_tool_call | MCP tool invocation |

### mocks-errors.json

| Trigger | Status | Error Type |
|---------|--------|------------|
| "trigger rate limit" | 429 | rate_limit_error |
| "trigger server error" | 500 | api_error |
| "trigger overloaded error" | 529 | overloaded_error |
| "trigger invalid request" | 400 | invalid_request_error |
| "trigger authentication error" | 401 | authentication_error |
| "trigger permission error" | 403 | permission_error |
| "trigger not found error" | 404 | not_found_error |
| "trigger context length error" | 400 | invalid_request_error (context) |
| "trigger tool error" | 200 | Tool error response |
| "trigger max turns error" | 200 | Max turns message |

### mocks-room.json

| Agent | Scenario | Tools Used |
|-------|----------|------------|
| Chat | Simple text response | None |
| Planner | Phase 1 - Create plan | Write |
| Planner | Phase 2 - Create tasks | mcp_tool_call |
| Coder | Implement task | Write |
| Leader | Submit for review | mcp_tool_call (submit_for_review) |
| Leader | Complete task | mcp_tool_call (complete_task) |
| Reviewer | Review PR | Bash (gh pr view) |

## Request Matching Priority

Dev Proxy matches requests in this order:

1. **Exact match** - URL + method + body fragment
2. **URL match** - URL + method only
3. **Wildcard match** - URL pattern with wildcards

More specific matches take precedence over general ones.

## Adding New Mocks

1. Choose the appropriate mock file (or create a new one)
2. Add a new mock entry with:
   - `request.url` - The API endpoint
   - `request.method` - HTTP method (usually POST)
   - `request.bodyFragment` - Optional request body matcher
   - `response.statusCode` - HTTP status code
   - `response.headers` - Response headers
   - `response.body` - Anthropic API response format

Example:

```json
{
  "request": {
    "url": "https://api.anthropic.com/v1/messages",
    "method": "POST",
    "bodyFragment": {
      "messages": [
        {
          "content": "your trigger phrase here"
        }
      ]
    }
  },
  "response": {
    "statusCode": 200,
    "headers": [
      {
        "name": "content-type",
        "value": "application/json"
      }
    ],
    "body": {
      "id": "msg_custom_001",
      "type": "message",
      "role": "assistant",
      "content": [
        {
          "type": "text",
          "text": "Your response text here"
        }
      ],
      "model": "claude-sonnet-4-20250514",
      "stop_reason": "end_turn",
      "stop_sequence": null,
      "usage": {
        "input_tokens": 10,
        "output_tokens": 10,
        "cache_creation_input_tokens": 0,
        "cache_read_input_tokens": 0,
        "service_tier": "standard"
      }
    }
  }
}
```

## Documentation

For more details, see [docs/dev-proxy-integration.md](../docs/dev-proxy-integration.md).
