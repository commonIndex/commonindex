# Task detail views

Open a task from the board as before. **Full page** in its header expands the
same task into a reading layout, with linked work and ownership alongside the
criteria and discussion on wide screens. **Side panel** restores the board;
**Back to board** closes the task.

The URL records the mode: `/board?task=<id>&view=full`. Opening that URL or
refreshing restores the full-page layout. Switching between the panel and full
page does not submit or discard an open task edit, review note, or comment draft.
This is an in-memory guarantee when switching views, not draft persistence across
page reloads or closing the task.

The detail view includes:

- Status, key, and task actions in a persistent header.
- A state-specific action area, with a warning when review checks are incomplete.
- Explicit met / not met / not checked labels and an actual criteria progress bar.
- Assignee, creator, last update, and grouped linked-work cards.
- Keyboard-accessible Comments and Activity tabs; hidden comments retain drafts
  but do not poll or mark new messages read until reopened.
- Retry on failed task reads, and visible errors during task editing.

The UI uses the existing gateway permissions, revision checks, and task verbs.
It does not infer completion, accept work automatically, or change task data just
because the view was expanded.

Regression coverage: `web/src/views/__tests__/Board.test.tsx`,
`web/src/components/__tests__/TaskLinks.test.tsx`, and
`web/src/components/__tests__/ConversationExperience.test.tsx`.
