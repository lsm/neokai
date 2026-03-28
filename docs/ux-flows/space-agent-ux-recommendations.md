# Space Agent UX Recommendations

## Overview

Based on the "first task" flow analysis and review of the current SpaceTaskPane implementation, this document provides specific UX recommendations to improve the task/agent interaction experience.

## Current Strengths

### What Works Well

1. **Real-time Activity Tracking**
   - LiveQuery subscriptions provide instant updates
   - No manual refresh needed
   - Status changes propagate across all views

2. **Clear Visual Hierarchy**
   - Task metadata at top (status, priority, agent)
   - Activity section prominently displayed
   - Conversation-style agent updates feel natural

3. **Human Gate Handling**
   - "Human Input Required" section is clear and actionable
   - Input draft persistence prevents lost work
   - Simple textarea + submit pattern is intuitive

4. **Navigation Model**
   - Deep links work correctly
   - "View Agent Session" provides escape hatch to full conversation
   - "Open Space Agent" offers alternative control path

## Recommendations for Improvement

### High Priority

#### 1. Add Explicit Task Control Actions

**Current State**: Task status changes happen implicitly (via agent or human input submission)

**Recommendation**: Add explicit action buttons to task pane header

```
┌──────────────────────────────────────────────────────┐
│ Implement User Authentication          [Cancel][⋯]   │
│ #42 · Standalone Task                                │
└──────────────────────────────────────────────────────┘

[⋯] dropdown options:
- Pause Task
- Change Priority → submenu (Low/Normal/High/Urgent)
- Reassign Agent → agent picker
- Archive Task
```

**Why**: Users need direct control without relying on conversational commands

**Implementation**: Add `TaskActionsMenu` component to SpaceTaskPane header

---

#### 2. Improve Activity Section Loading States

**Current State**: Activity section may appear empty briefly during LiveQuery initialization

**Recommendation**: Add skeleton loading state

```
╔═══════════════════════════════════════════════════════╗
║ ACTIVITY                                   [View Chat]  ║
║                                                        ║
║ ┌─────────────────────────────────────────────────┐   ║
║ │ ▮▮▮▮▮▮▮▮▮▮▮▮▮▮ Loading...                      │   ║
║ │ ▮▮▮▮▮▮▮▮▮                                       │   ║
║ └─────────────────────────────────────────────────┘   ║
╚═══════════════════════════════════════════════════════╝
```

**Why**: Prevents jarring empty → populated transition

**Implementation**: Check if `activityRows.length === 0` in first 500ms, show skeleton

---

#### 3. Add Visual Task Progress Indicators

**Current State**: Status badge shows current state but not progress within that state

**Recommendation**: Add progress bar or step indicator for in-progress tasks

```
┌─────────────────────────────────────────────────────┐
│ STATUS             PROGRESS                          │
│ [In Progress]●     ▓▓▓▓▓▓▓░░░░░░░░░ 45%             │
│                    Step 3 of 7: Implementing tests   │
└─────────────────────────────────────────────────────┘
```

**Why**: Users can gauge how far along the task is without reading full activity

**Implementation**: Track task phases in `SpaceTask.processingPhase` and calculate percentage

---

#### 4. Enhance "Open Space Agent" / "View Agent Session" CTAs

**Current State**: Buttons use similar styling; unclear when to use which

**Recommendation**: Differentiate visually and add helper text

```
║ [View Agent Session] ──────────────────────────────►   ║
║ See the full conversation with the task agent          ║
║                                                        ║
║ [Open Space Agent]                                     ║
║ Chat with the space agent to monitor or steer tasks    ║
```

**Why**: Users need to understand the difference between task agent and space agent

**Implementation**: Add helper text + different button styles (primary vs secondary)

---

### Medium Priority

#### 5. Add Task History/Timeline View

**Current State**: Only current state and latest agent update visible

**Recommendation**: Add collapsible timeline section

```
HISTORY ▼
┌─────────────────────────────────────────────────────┐
│ 2 min ago  ✓ Completed                              │
│            Task agent finished implementation         │
│                                                      │
│ 5 min ago  ⚠ Needs Attention                        │
│            Human approval required for dependencies   │
│                                                      │
│ 8 min ago  ● In Progress                            │
│            Task agent started working                │
│                                                      │
│ 10 min ago ○ Created                                │
│            Task created via Space Agent               │
└─────────────────────────────────────────────────────┘
```

**Why**: Provides context for how task progressed; useful for debugging or learning

**Implementation**: Store state transitions in `space_task_history` table (new)

---

#### 6. Improve Related Workflow Tasks Display

**Current State**: Related tasks shown as flat list with minimal info

**Recommendation**: Show workflow graph context

```
WORKFLOW CONTEXT
┌─────────────────────────────────────────────────────┐
│ Plan → Code → [Test] → Review → Deploy              │
│               ↑                                       │
│            You are here                              │
│                                                      │
│ Related tasks:                                       │
│ ✓ Plan       Completed 10 min ago                   │
│ ✓ Code       Completed 5 min ago                    │
│ ● Test       In Progress (this task)                │
│ ○ Review     Waiting                                 │
│ ○ Deploy     Waiting                                 │
└─────────────────────────────────────────────────────┘
```

**Why**: Users understand task's role in larger workflow without opening canvas

**Implementation**: Render mini workflow graph in task pane

---

#### 7. Add Estimated Time Remaining

**Current State**: No indication of how long task might take

**Recommendation**: Show estimate based on agent activity

```
╔═══════════════════════════════════════════════════════╗
║ ACTIVITY                                   [View Chat]  ║
║                                                        ║
║ Task agent is working                  ~3 minutes left ║
║                                                        ║
║ Currently implementing authentication endpoints        ║
╚═══════════════════════════════════════════════════════╝
```

**Why**: Manages user expectations; helps prioritize attention

**Implementation**: Track average task completion times per agent/task type; show estimate

---

### Low Priority (Polish)

#### 8. Add Task Tags/Labels

**Current State**: Only priority and status for categorization

**Recommendation**: Allow custom tags

```
┌─────────────────────────────────────────────────────┐
│ STATUS     PRIORITY     TAGS                         │
│ [Pending]  [High]       [backend] [auth] [security]  │
└─────────────────────────────────────────────────────┘
```

**Why**: Helps organize tasks; enables filtering by category

**Implementation**: Add `tags: string[]` to SpaceTask schema

---

#### 9. Add Quick Task Templates

**Current State**: Every task starts from blank form

**Recommendation**: Provide common task templates

```
Create Task dialog:
┌─────────────────────────────────────────────────────┐
│ Start from template (optional):                     │
│ [Bug Fix] [Feature] [Refactor] [Documentation] [Custom] │
│                                                      │
│ Title: ___________________________________________   │
│ Description: ____________________________________   │
└─────────────────────────────────────────────────────┘
```

**Why**: Speeds up task creation; ensures consistent task descriptions

**Implementation**: Store templates in space settings or global config

---

#### 10. Improve Mobile/Tablet Experience

**Current State**: Three-column layout doesn't adapt well to narrow screens

**Recommendation**: Collapsible panels with priority-based visibility

**Mobile**:
- NavRail collapses to hamburger menu
- SpaceDetailPanel slides in as drawer (hidden by default)
- ContentPanel takes full width
- Task pane shows condensed view with expandable sections

**Why**: Makes Spaces usable on mobile devices

**Implementation**: Media queries + responsive SpaceDetailPanel drawer

---

## Interaction Pattern Refinements

### A. Conversation vs Control Balance

**Current**: Hybrid model with both conversational (Space Agent) and direct control (buttons)

**Refinement**: Clearly signal which method to use when

**Guidelines**:
- **Use Space Agent when**: Exploring options, getting summaries, complex multi-step operations
- **Use Direct Controls when**: Quick status changes, simple actions, browsing tasks

**UI Indicator**: Add help tooltip next to "Open Space Agent" explaining when to chat vs click

---

### B. Status Transition Clarity

**Current**: Some status changes happen implicitly (e.g., needs_attention → in_progress after input)

**Refinement**: Always show transition confirmation

```
╔═══════════════════════════════════════════════════════╗
║ Your response was submitted                            ║
║ Task status: Needs Attention → In Progress             ║
║ The agent will resume work shortly.                    ║
╚═══════════════════════════════════════════════════════╝
```

**Why**: Users understand cause and effect

---

### C. Agent Handoff Transparency

**Current**: Task may switch from task agent → worker → leader without clear indication

**Refinement**: Show handoff events in activity section

```
AGENT ACTIVITY
┌─────────────────────────────────────────────────────┐
│ ┌─ HANDOFF ──────────────────────────────────────┐  │
│ │ Task Agent completed planning phase             │  │
│ │ → Worker Agent is now handling implementation   │  │
│ └─────────────────────────────────────────────────┘  │
│                                                      │
│ ┌─ WORKER AGENT ───────────────────────────────┐    │
│ │ Starting implementation of authentication...   │    │
│ └─────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────┘
```

**Why**: Users understand why different agents are involved

---

## Edge Cases to Handle

### 1. Task Stuck/Stale

**Symptom**: Task in "in_progress" but no activity for >10 minutes

**UX Response**: Show warning badge + suggested actions

```
╔═══════════════════════════════════════════════════════╗
║ ⚠ Task may be stalled                                  ║
║                                                        ║
║ No activity detected for 12 minutes.                   ║
║                                                        ║
║ Suggested actions:                                     ║
║ • [View Agent Session] to check for errors             ║
║ • [Retry Task] to restart execution                    ║
║ • [Contact Space Agent] for diagnosis                  ║
╚═══════════════════════════════════════════════════════╝
```

---

### 2. Agent Error/Crash

**Symptom**: Task status "in_progress" but agent session ended unexpectedly

**UX Response**: Show error state with recovery options

```
╔═══════════════════════════════════════════════════════╗
║ ✗ Agent encountered an error                           ║
║                                                        ║
║ Error: Rate limit exceeded (429)                       ║
║                                                        ║
║ Suggested actions:                                     ║
║ • [Retry in 5 minutes] (automatic)                     ║
║ • [Switch to different model] (manual)                 ║
║ • [View error details]                                 ║
╚═══════════════════════════════════════════════════════╝
```

---

### 3. Conflicting Task Updates

**Symptom**: Two users edit same task simultaneously (in collaborative spaces)

**UX Response**: Show conflict warning + merge UI

```
╔═══════════════════════════════════════════════════════╗
║ ⚠ Task was updated by another user                     ║
║                                                        ║
║ Alice changed priority: Normal → High                  ║
║ You changed status: Pending → In Progress              ║
║                                                        ║
║ [Accept Both Changes] [Keep Mine] [Keep Theirs]        ║
╚═══════════════════════════════════════════════════════╝
```

---

## Accessibility Considerations

### Screen Reader Support

1. **Task status changes**: Announce via ARIA live regions
2. **Agent activity**: Label agent message bubbles with roles
3. **Human input form**: Properly associated labels and error messages
4. **Action buttons**: Clear ARIA labels (not just icons)

### Keyboard Navigation

1. **Task list**: Arrow keys to navigate, Enter to open
2. **Task pane**: Tab order: header actions → activity section → input form → buttons
3. **Quick actions**: Keyboard shortcuts (e.g., `Cmd+K` to create task)

### Visual Considerations

1. **Status colors**: Don't rely solely on color (use icons + text)
2. **Loading states**: Announce to screen readers
3. **Error states**: Use both color and icon
4. **Contrast**: Ensure all text meets WCAG AA standards

---

## Performance Considerations

### LiveQuery Efficiency

**Current**: Separate subscriptions for tasks, agents, workflows, runs

**Optimization**: Batch-subscribe to space context

```typescript
// Instead of:
spaceStore.tasks.value
spaceStore.agents.value
spaceStore.workflows.value
spaceStore.workflowRuns.value

// Use:
spaceStore.subscribeToSpace(spaceId) // returns all relevant data
```

**Why**: Reduces WebSocket messages and re-renders

---

### Activity Feed Pagination

**Current**: All activity loaded at once

**Optimization**: Paginate agent activity for long-running tasks

```
AGENT ACTIVITY
┌─────────────────────────────────────────────────────┐
│ Showing last 10 messages                             │
│ [Load earlier messages] ←                            │
│                                                      │
│ ┌─ TASK AGENT ────────────────────────────────┐     │
│ │ Latest update...                            │     │
│ └─────────────────────────────────────────────┘     │
└─────────────────────────────────────────────────────┘
```

**Why**: Prevents DOM bloat for tasks with hundreds of agent messages

---

## Success Metrics (KPIs)

To measure UX improvements:

1. **Time to First Task**: Time from landing on dashboard to task creation
2. **Task Completion Rate**: % of started tasks that complete (not cancelled)
3. **Human Gate Response Time**: Median time from `needs_attention` to input submission
4. **Agent Session Views**: % of tasks where user opens agent session (indicates need for more context)
5. **Error Recovery Success**: % of failed tasks that succeed after retry
6. **Mobile Usage**: % of space interactions from mobile/tablet devices

**Target Benchmarks**:
- Time to First Task: <60 seconds (including reading time)
- Task Completion Rate: >85%
- Human Gate Response Time: <5 minutes
- Agent Session Views: 30-40% (not too high = good in-task visibility)
- Error Recovery Success: >70%
- Mobile Usage: Support goal of 10%+ within 6 months

---

## Implementation Priority

### Phase 1 (Essential for First-Time Users)
- [ ] Task control actions (Recommendation #1)
- [ ] Activity loading states (Recommendation #2)
- [ ] Differentiated CTA buttons (Recommendation #4)

### Phase 2 (Improved Monitoring)
- [ ] Task progress indicators (Recommendation #3)
- [ ] Task history timeline (Recommendation #5)
- [ ] Stale task detection (Edge Case #1)

### Phase 3 (Polish & Scale)
- [ ] Workflow context visualization (Recommendation #6)
- [ ] Estimated time remaining (Recommendation #7)
- [ ] Mobile/tablet responsive (Recommendation #10)

### Phase 4 (Future)
- [ ] Task tags/labels (Recommendation #8)
- [ ] Task templates (Recommendation #9)
- [ ] Advanced collaboration features (Edge Case #3)

---

**Document Status**: Recommendations based on UX flow analysis
**Last Updated**: 2026-03-28
**Related Docs**:
- `docs/ux-flows/first-space-task-flow.md` (user journey documentation)
- `docs/plans/audit-space-uiux-gaps-via-live-app-testing-with-chrome-mcp/00-overview.md` (technical audit)
