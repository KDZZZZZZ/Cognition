# Interactive QA Inventory

## Claims To Sign Off

- Users can upload the textbook and paper PDFs from the explorer UI without backend bootstrapping.
- Users can create a Markdown note and a session from the explorer quick action flow.
- Session context permissions can be changed in the UI so PDFs are readable and notes are writable.
- The textbook long-scope flow writes a pending diff instead of mutating the note silently.
- The textbook QA flow stays read-only even when a writable note exists.
- The paper summary flow can pause and resume in the UI and can add chart evidence to the note workflow.
- The local paper collection flow stays local-only and does not depend on web search.

## Controls And Expected State Changes

- `Add at current path` opens the quick action menu.
- `New File`, `New Session`, `New Folder` open the item dialog and create tree nodes.
- `Upload File` opens the hidden upload input and starts the progress card.
- The upload progress card shows phase, current file, percentage, and remaining-time state until upload settles.
- Clicking a tree item opens the file or session tab in the active pane.
- The session context permission chip cycles between `read`, `write`, and `none` depending on file type.
- The task board toggle expands the registered steps for the current session.
- The chat textarea sends a request on Enter.
- The paused-task panel allows continuing with the recommended option.
- The pending diff pane exposes `Accept All` and `Reject All`.

## Functional Checks

- Scenario 1 checks upload, note creation, session creation, permission assignment, page navigation, task path, citations, and pending diff creation.
- Scenario 2 checks the same setup path but verifies no editor tool or diff appears.
- Scenario 3 checks paper upload, note/session setup, paused-task resume, visual-tool usage, and pending diff creation.
- Scenario 4 checks paper upload and session setup, local-only collection output shape, and no unintended writeback.

## Visual Checks

- The explorer quick action menu is visible and clipped correctly near the root path bar.
- The upload progress ring and card remain readable while the large textbook upload is running.
- The session context chips show readable/writable state clearly.
- The task board reveals step progression without clipping.
- The paused-task panel clearly marks the recommended option.
- The pending diff panel exposes diff controls and keeps code/math rendering legible.

## Evidence To Capture

- Initial workspace state before each scenario.
- Explorer quick action menu open.
- Upload progress card during textbook upload.
- Session context file chips after permissions are set.
- Expanded task board after the first model turn.
- Paused-task panel before continuing in the paper summary scenario.
- Pending diff view for the textbook long-scope and paper summary scenarios.

## Exploratory Checks

- Retry the quick action flow after a refresh to catch stale menu or dialog state.
- Flip a note permission from `write` back to `read` and confirm the UI recovers.
- Send a second prompt after a paused task resumes to catch lingering disabled input state.
