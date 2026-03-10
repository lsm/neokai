# PR Review Workflow - Design

## Overview

Automate the GitHub PR + multi-round AI peer review workflow within room autonomous execution.
The coding agent creates a PR, the leader (as coordinator) spawns reviewer sub-agents from
different models/providers, iterates until all blocking findings are resolved, then parks the
task for human approval while the room moves on to the next task.

## Task Lifecycle

```mermaid
stateDiagram-v2
    [*] --> draft
    draft --> pending : plan approved
    pending --> in_progress : runtime spawns group
    in_progress --> review : leader calls submit_for_review
    in_progress --> failed
    review --> completed : human approves
    review --> in_progress : human rejects (with feedback)

    note right of review
        Group slot freed.
        Room picks up next task.
        Human decision resumes leader flow.
    end note
```

## Current Session Group State

`session_groups.state` is compatibility metadata and currently uses:

- `awaiting_worker`
- `awaiting_leader`
- `awaiting_human`
- `completed`
- `failed`

`hibernated` is removed from the active model.

## Worker → Leader → Human Flow

```mermaid
flowchart TB
    subgraph Runtime["Room Runtime"]
        Tick["Tick Loop<br/>(picks next pending task)"]
    end

    subgraph Worktree["Shared Worktree (per task, read-only for leader + sub-agents)"]

        subgraph Worker["Worker (Coder)"]
            W1["Read task + goal context"] --> W2["Write code, tests"]
            W2 --> W3["Commit + create PR via gh"]
            W3 --> W_term["Terminal state"]
            W_feedback["Receive feedback"] --> W_fix["Push fixes to same branch"]
            W_fix --> W_term2["Terminal state"]
        end

        subgraph Gate["Worktree Cleanliness Gate"]
            G1{"git status<br/>clean?"}
        end

        subgraph Leader["Leader (Coordinator Mode)"]
            L1["Review worker output"]
            L2["Spawn / resume reviewer sub-agents"]
            L3["Read PR comments"]
            L4{All P0/P1<br/>resolved?}
            L1 --> L2 --> L3 --> L4
        end

        subgraph Reviewers["Reviewer Sub-agents (read-only)"]
            direction LR
            R1["reviewer-opus<br/>SDK session<br/>reviews directly"]
            R2["reviewer-glm5<br/>SDK session<br/>reviews directly"]
            R3["reviewer-codex<br/>SDK sub-agent (sonnet)<br/>calls codex via Bash<br/>posts output via gh"]
        end
    end

    Tick -->|"spawn group"| Worker
    W_term --> G1
    W_term2 --> G1
    G1 -->|"Yes"| L1
    G1 -->|"No: auto-reply worker"| W_feedback

    L2 -->|"Task tool"| Reviewers
    Reviewers -->|"Bash: gh pr comment"| PR["GitHub PR"]
    L3 -.->|"reads comments"| PR

    L4 -->|"No: send_to_worker"| W_feedback
    L4 -->|"Yes: submit_for_review(pr_url)"| Review["Task → review status<br/>submittedForReview=true"]
    Review --> Slot["Group slot freed<br/>task parked for human"]
    Slot --> Tick

    H["Human review"]
    Review --> H
    H -->|"task.approve"| ResumeA["runtime.resumeWorkerFromHuman(..., approved=true)<br/>resumeLeaderFromHuman()"]
    H -->|"task.reject(feedback)"| ResumeR["runtime.resumeWorkerFromHuman(..., approved=false)<br/>resumeLeaderFromHuman()"]
    H -->|"task.sendHumanMessage(target)"| HM["Direct inject to worker/leader"]

    ResumeA --> L1
    ResumeR --> L1
    HM --> W_feedback
    HM --> L1
```

## Reviewer Sub-agent Detail

The leader uses the coordinator's Task tool to spawn reviewer sub-agents. On subsequent
rounds, the leader is instructed to use `Task(resume: agentId)` to continue each reviewer's
session with full prior context preserved. This is the leader's choice — we just describe the
behavior in its system prompt.

```mermaid
sequenceDiagram
    participant Leader
    participant RevOpus as Reviewer (opus)
    participant RevCLI as Reviewer (sonnet + codex CLI)
    participant GH as GitHub PR

    Note over Leader: Round 1 — spawn reviewers
    Leader->>RevOpus: Task(subagent_type: reviewer-opus)
    RevOpus->>RevOpus: Read diff, analyze code
    RevOpus->>GH: Bash: gh pr comment --body "## Review by opus..."
    RevOpus-->>Leader: verdict + agentId: abc123

    Leader->>RevCLI: Task(subagent_type: reviewer-codex)
    RevCLI->>RevCLI: Bash: codex "review these changes..."
    RevCLI->>GH: Bash: gh pr comment --body "<codex review>"
    RevCLI-->>Leader: verdict + agentId: def456

    Note over Leader: Evaluate — P1 found, send worker back
    Leader->>Leader: send_to_worker(consolidated feedback)

    Note over Leader: Round 2 — resume same reviewers
    Leader->>RevOpus: Task(resume: abc123, prompt: "Fixes pushed...")
    RevOpus->>GH: Bash: gh pr comment --body "## Round 2 — P1 resolved..."
    RevOpus-->>Leader: approved

    Leader->>RevCLI: Task(resume: def456, prompt: "Fixes pushed...")
    RevCLI->>GH: Bash: gh pr comment --body "## Round 2 — approved"
    RevCLI-->>Leader: approved

    Note over Leader: All approved → submit_for_review (task enters review)
```

---
## Current Implementation Notes

- Human approval and rejection use task-scoped RPCs:
  - `task.approve` resumes review tasks with `approved=true`
  - `task.reject` resumes review tasks with `approved=false`
- `task.sendHumanMessage` is available at any time and routes directly to worker or leader.
- Terminal status changes clean up runtime resources via runtime APIs:
  - `task.cancel` and `task.setStatus(..., cancelled)` use runtime cancellation
  - `task.setStatus(..., completed|failed)` uses runtime group termination

## Configuration (No New Tables)

Room agent configuration lives in the existing `Room.config` JSON field:

```json
{
  "reviewers": [
    { "model": "claude-opus-4-6", "provider": "anthropic" },
    { "model": "glm-5", "provider": "glm" },
    { "model": "codex", "type": "cli" }
  ],
  "maxReviewRounds": 5
}
```

The **Agents tab** reads available providers/models from the existing provider registry
and writes selections to `Room.config`. No new database tables.

## What We're NOT Building

- No new database tables
- No new runtime orchestration phase — leader handles review loop as coordinator
- No programmatic resume wiring — leader decides when to resume sub-agents
- No GitHub webhook integration — `gh` CLI is sufficient
- No special "CLI wrapper" agent type — just a normal sub-agent that calls CLI via Bash
- No `escalated` task status — tasks either fail or go to review
