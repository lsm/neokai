# First Space Task Flow — User Experience Documentation

## Overview

This document describes the end-to-end UX flow for creating and tracking the first task in a Space, from a human user's perspective. It captures the intended interaction model after the Space UI/UX redesign.

## User Journey: Creating the First Task

### Entry Point: Space Dashboard

**User arrives at**: `/space/:id` (Space Dashboard)

**What they see**:
- Three-column layout: NavRail → SpaceDetailPanel → Dashboard content
- SpaceDetailPanel shows:
  - Task stats strip (e.g., "0 active · 0 review")
  - Pinned items: Dashboard, Space Agent
  - Empty "Workflow Runs" section
  - Empty "Tasks" section
  - "Sessions" section with Space Agent session

**Visual state**: Clean, empty state with clear call-to-action

### Step 1: Initiating Task Creation

**Two paths available**:

#### Path A: Via Space Agent (Conversational)
1. Click "Space Agent" in SpaceDetailPanel
2. Navigate to `/space/:id/agent`
3. See ChatContainer with space agent session
4. Type natural language request: "Create a task to implement user authentication"
5. Space agent uses MCP tools to create the task
6. Agent responds with confirmation and task details
7. SpaceDetailPanel updates in real-time (LiveQuery) showing new task

#### Path B: Via Quick Action (Direct)
1. On Dashboard, click "Create Task" quick action button
2. Dialog appears: SpaceCreateTaskDialog
3. Fill in:
   - **Title**: "Implement user authentication"
   - **Description**: Detailed requirements
   - **Priority**: Normal/High/Urgent
   - **Assigned Agent**: Dropdown (Coder/General/Custom agents)
   - **Workflow**: Optional - select workflow template or leave standalone
4. Click "Create"
5. Dialog closes, task appears in SpaceDetailPanel

**Recommended for first-time users**: Path A (Space Agent) provides guided experience with explanation

### Step 2: Task Appears in Context Panel

**SpaceDetailPanel updates** (real-time via LiveQuery):
```
┌─────────────────────────┐
│ 1 pending · 0 active    │  ← Stats updated
├─────────────────────────┤
│ Dashboard               │
│ Space Agent             │
├─────────────────────────┤
│ ▼ Tasks                 │
│  [pending] [active]     │  ← Tab filters
│   ● Implement user auth │  ← New task (pending status)
│     Priority: High      │
│     Agent: Coder        │
└─────────────────────────┘
```

### Step 3: Viewing Task Details

**User clicks** on "Implement user auth" task in SpaceDetailPanel

**Navigation**: URL changes to `/space/:id/task/:taskId`

**ContentPanel shows**: Full-width SpaceTaskPane

**Layout**:
```
┌──────────────────────────────────────────────────────────────┐
│ [← Back]                                        [Close]       │
│                                                                │
│ Implement User Authentication                                 │
│ #42 · Standalone Task                                         │
│                                                                │
│ ┌─────────────────────────────────────────────────────┐      │
│ │ STATUS             PRIORITY         AGENT            │      │
│ │ [Pending]          [High]           Coder Agent      │      │
│ └─────────────────────────────────────────────────────┘      │
│                                                                │
│ ╔═══════════════════════════════════════════════════════╗    │
│ ║ ACTIVITY                                               ║    │
│ ║                                                        ║    │
│ ║ The task is queued                                     ║    │
│ ║                                                        ║    │
│ ║ This task has not started yet. Use the space agent    ║    │
│ ║ thread to steer the next step.                         ║    │
│ ║                                                        ║    │
│ ║ [Open Space Agent] ────────────────────────────────►   ║    │
│ ╚═══════════════════════════════════════════════════════╝    │
│                                                                │
│ DESCRIPTION                                                    │
│ ┌─────────────────────────────────────────────────────┐      │
│ │ Implement JWT-based authentication system with:      │      │
│ │ - Login/logout endpoints                             │      │
│ │ - Token refresh mechanism                            │      │
│ │ - Session management                                 │      │
│ └─────────────────────────────────────────────────────┘      │
└──────────────────────────────────────────────────────────────┘
```

### Step 4: Starting Task Execution

**User has three options**:

#### Option A: Start via Space Agent
1. Click "Open Space Agent" button in task pane
2. Navigate to `/space/:id/agent`
3. Type: "Start the authentication task"
4. Agent acknowledges and initiates task execution

#### Option B: Start via Workflow
1. Return to Dashboard (`/space/:id`)
2. Click "Start Workflow Run" quick action
3. Select "Coding Workflow" template
4. Select task(s) to include
5. Click "Start"
6. Workflow run begins, task status updates to "in_progress"

#### Option C: Auto-start (if configured)
- Space may have auto-execution rules
- Task starts automatically based on dependencies/schedule

### Step 5: Watching Task Progress

**Task status changes**: `pending` → `in_progress`

**SpaceTaskPane updates** (user still on `/space/:id/task/:taskId`):

```
┌──────────────────────────────────────────────────────────────┐
│ Implement User Authentication                                 │
│ #42 · Standalone Task                                         │
│                                                                │
│ ┌─────────────────────────────────────────────────────┐      │
│ │ STATUS             PRIORITY         AGENT            │      │
│ │ [In Progress]●     [High]           Coder Agent      │      │
│ └─────────────────────────────────────────────────────┘      │
│                                                                │
│ ╔═══════════════════════════════════════════════════════╗    │
│ ║ ACTIVITY                                   [View Chat]  ║    │
│ ║                                                        ║    │
│ ║ Task agent is working                                  ║    │
│ ║                                                        ║    │
│ ║ Currently analyzing existing authentication patterns   ║    │
│ ║ and planning implementation approach.                  ║    │
│ ║                                                        ║    │
│ ║ ┌─────────────────────────────────────────────────┐   ║    │
│ ║ │ TASK AGENT                                      │   ║    │
│ ║ │ ● Active                                        │   ║    │
│ ║ │ Analyzing codebase structure                    │   ║    │
│ ║ └─────────────────────────────────────────────────┘   ║    │
│ ║                                                        ║    │
│ ║ [View Agent Session] ──────────────────────────────►   ║    │
│ ╚═══════════════════════════════════════════════════════╝    │
│                                                                │
│ AGENT ACTIVITY                                                 │
│ ┌─────────────────────────────────────────────────────┐      │
│ │ ┌─ TASK AGENT ────────────────────────────────────┐ │      │
│ │ │ I've analyzed the current authentication setup.  │ │      │
│ │ │ I'll implement JWT-based auth with:              │ │      │
│ │ │ 1. Login endpoint with bcrypt password hashing   │ │      │
│ │ │ 2. JWT token generation and verification         │ │      │
│ │ │ 3. Refresh token mechanism                       │ │      │
│ │ │ 4. Session middleware for protected routes       │ │      │
│ │ └──────────────────────────────────────────────────┘ │      │
│ └─────────────────────────────────────────────────────┘      │
└──────────────────────────────────────────────────────────────┘
```

**LiveQuery subscription** ensures real-time updates without page refresh

### Step 6: Human Gate Interaction

**Scenario**: Task agent needs approval to proceed

**Task status changes**: `in_progress` → `needs_attention`

**SpaceTaskPane updates**:

```
╔═══════════════════════════════════════════════════════╗
║ ACTIVITY                                   [View Chat]  ║
║                                                        ║
║ Waiting on your input                                  ║
║                                                        ║
║ The agent needs your approval to install new           ║
║ dependencies: jsonwebtoken, bcryptjs                   ║
║                                                        ║
║ ┌─────────────────────────────────────────────────┐   ║
║ │ HUMAN INPUT REQUIRED                            │   ║
║ │                                                 │   ║
║ │ This task needs your attention before it can    │   ║
║ │ continue.                                        │   ║
║ │                                                 │   ║
║ │ ┌─────────────────────────────────────────────┐ │   ║
║ │ │ Type your response or approval...           │ │   ║
║ │ │                                             │ │   ║
║ │ │                                             │ │   ║
║ │ └─────────────────────────────────────────────┘ │   ║
║ │                                                 │   ║
║ │ [Submit Response]                                │   ║
║ └─────────────────────────────────────────────────┘   ║
╚═══════════════════════════════════════════════════════╝
```

**User types**: "Approved. Please proceed with installation."

**User clicks**: "Submit Response"

**Task status changes**: `needs_attention` → `in_progress`

**Execution resumes** with agent receiving the human input

### Step 7: Task Completion

**Task status changes**: `in_progress` → `completed`

**SpaceTaskPane final state**:

```
┌──────────────────────────────────────────────────────────────┐
│ Implement User Authentication                      [Archive]  │
│ #42 · Standalone Task                                         │
│                                                                │
│ ┌─────────────────────────────────────────────────────┐      │
│ │ STATUS             PRIORITY         AGENT            │      │
│ │ [Completed]✓       [High]           Coder Agent      │      │
│ └─────────────────────────────────────────────────────┘      │
│                                                                │
│ ╔═══════════════════════════════════════════════════════╗    │
│ ║ ACTIVITY                                   [View Chat]  ║    │
│ ║                                                        ║    │
│ ║ The task is complete                                   ║    │
│ ║                                                        ║    │
│ ║ Successfully implemented JWT-based authentication      ║    │
│ ║ system with login/logout endpoints, token refresh,     ║    │
│ ║ and session middleware. All tests passing.             ║    │
│ ║                                                        ║    │
│ ║ [View Agent Session] ──────────────────────────────►   ║    │
│ ╚═══════════════════════════════════════════════════════╝    │
│                                                                │
│ COMPLETION SUMMARY                                             │
│ ┌─────────────────────────────────────────────────────┐      │
│ │ Implemented:                                         │      │
│ │ • POST /auth/login - JWT token generation            │      │
│ │ • POST /auth/logout - Session cleanup                │      │
│ │ • POST /auth/refresh - Token refresh                 │      │
│ │ • Middleware: authenticateToken                      │      │
│ │ • Tests: 12 passing                                  │      │
│ │                                                      │      │
│ │ Files changed: 5 files                               │      │
│ │ • src/auth/authController.ts (new)                   │      │
│ │ • src/middleware/auth.ts (new)                       │      │
│ │ • src/routes/auth.ts (new)                           │      │
│ │ • tests/auth.test.ts (new)                           │      │
│ │ • package.json (dependencies)                        │      │
│ └─────────────────────────────────────────────────────┘      │
└──────────────────────────────────────────────────────────────┘
```

**SpaceDetailPanel updates**:
```
┌─────────────────────────┐
│ 0 active · 1 done       │  ← Stats updated
├─────────────────────────┤
│ Dashboard               │
│ Space Agent             │
├─────────────────────────┤
│ ▼ Tasks                 │
│  [active] [done]        │  ← Filter tabs
│   ✓ Implement user auth │  ← Completed (green)
│     Completed 2 min ago │
└─────────────────────────┘
```

## Key UX Principles Demonstrated

### 1. **Conversational + Direct Control**
- Users can work conversationally (via Space Agent) or directly (via UI buttons)
- Space Agent provides guidance and context
- Direct actions (Create Task button) are faster for experienced users

### 2. **Real-time Visibility**
- LiveQuery subscriptions keep all views in sync
- No page refresh needed
- Status changes appear immediately in both ContextPanel and ContentPanel

### 3. **Progressive Disclosure**
- Dashboard shows high-level overview
- Task pane reveals detailed activity and agent communication
- "View Agent Session" provides full conversation history

### 4. **Context Preservation**
- URL reflects current context (`/space/:id/task/:taskId`)
- Deep links work (can bookmark task directly)
- Back button returns to dashboard

### 5. **Human-in-the-Loop**
- Human gates surface directly in task pane
- Clear indication of what's needed ("Human Input Required")
- Simple response mechanism (textarea + submit)
- Agent receives input and continues

### 6. **Activity Transparency**
- "ACTIVITY" section shows what's happening now
- Agent activity section shows conversation-style updates
- Completion summary preserves final outcome

## Workflow Variations

### Variation A: Workflow-Based Task

If task is part of a workflow run:

1. SpaceTaskPane shows "Workflow Step" instead of "Standalone Task"
2. Additional section appears: "Related Workflow Tasks"
3. WorkflowCanvas visualization shows current step highlighted
4. Task transitions trigger next workflow nodes automatically

### Variation B: Multi-Agent Collaboration

If workflow node has multiple agents:

1. Activity section shows multiple agent rows
2. Each agent has its own status badge (Active/Queued/Completed)
3. Conversation shows interleaved agent messages
4. Completion requires all agents to finish

### Variation C: Task Agent with Worker/Leader Sessions

If task spawns worker/leader architecture:

1. Activity shows both "Worker Agent" and "Leader Agent" rows
2. Button label changes: "View Worker Session" / "View Leader Session"
3. Task may show review status (leader reviewing worker output)

## Success Metrics

A successful "first task" experience should:

1. **Clarity**: User understands what's happening at each step
2. **Control**: User can pause, inspect, or intervene at any time
3. **Feedback**: Real-time updates confirm actions and progress
4. **Completion**: Clear outcome with summary of what was accomplished
5. **Learnability**: Space Agent provides guidance for next steps

## Common User Questions (and UX Answers)

**Q: "How do I know if the agent is working?"**
A: Activity section shows live status with current step description

**Q: "What if I need to stop the task?"**
A: Task status can be changed to "cancelled" (TODO: Add cancel button in task pane)

**Q: "How do I see what the agent actually did?"**
A: Click "View Agent Session" to see full conversation and tool calls

**Q: "Can I talk to the agent while it's working?"**
A: Yes - either via "View Agent Session" (task agent) or "Open Space Agent" (space agent can monitor/control tasks)

**Q: "What happens if multiple tasks run at once?"**
A: SpaceDetailPanel shows all active tasks; each has its own task pane and agent session

## Future Enhancements

### Near-term (already planned)
- [ ] Task status transition buttons (Mark Complete, Cancel)
- [ ] Task reassignment UI
- [ ] Workflow run detail view
- [ ] Mobile responsive layout

### Long-term considerations
- [ ] Task templates for common patterns
- [ ] Task dependencies visualization
- [ ] Batch operations (start multiple tasks)
- [ ] Task history and replay
- [ ] Export task results as artifacts

---

**Document Status**: Living document reflecting Space UI/UX as of 2026-03-28
**Last Updated**: Based on commits through f5d52f055 "Simplify task view around conversation"
**Related Docs**: `docs/plans/audit-space-uiux-gaps-via-live-app-testing-with-chrome-mcp/00-overview.md`
