# Antigravity manual dual-head acceptance

## Result

`npm run test:live-antigravity-manual` completed with `status: VERIFIED` and exit code 0. The test used an isolated real Antigravity process, the real SYNTRUM extension, two independent MCP stdio clients, SQLite, UDS, and a manual human edit. No mock extension, simulated document edit, or filesystem-polling substitute was used.

The human edited and saved `note.txt` in the isolated Antigravity window. A control file only released the harness; document contents, versions, and events came through the real adapter/MCP/event APIs.

## Criterion evidence

| Criterion | Status | Actual evidence |
|---|---|---|
| Agent 1 reads before human edit | VERIFIED | `note.txt` contained `initial text\n`, `TextDocument.version` 1, clean buffer. |
| Human modifies and saves in Antigravity | VERIFIED | Agent 1 subsequently read `SYNTRUM HUMAN GUI TEST\nEdited manually by the human.\nTesting shared application state.\n\n`, version 37, clean saved buffer. |
| Agent 1 reads updated content through MCP | VERIFIED | Real `document_read` returned the changed text and version 37, not the initial content. |
| Agent 2 receives actual document-change event | VERIFIED | Agent 2's UDS subscription received `document.changed` event ID 3 and `document.saved` event ID 45 for `note.txt`. |
| Correct versions and human origin | VERIFIED | Human event origin was `null`; the MCP document advanced to version 37, the winning agent write to 38, and the losing agent's retry to 39. |
| Concurrent writes have exactly one winner | VERIFIED | Agent A won at version 38; Agent B received `VERSION_CONFLICT` with the current version-38 snapshot. |
| Losing agent re-reads and retries | VERIFIED | Agent B re-read the winner and retried successfully, producing version 39 with `agent 1 concurrent write\nmanual-agent-b retry`. |
| Agent operations do not steal GUI focus | VERIFIED | Frontmost application PID/launch identity remained unchanged (PID 39724) across agent writes and retry. |
| Supervisor restart and extension reconnection | VERIFIED | SQLite session recovered, application stayed `running` with `verified` identity, extension reconnected, and MCP returned the version-39 document after restart. |
| No mocks or editor-event substitution | VERIFIED | Real MCP stdio agents, real Antigravity extension host and document events; the manual control file was not used as a document event source. |

## Regression checks

After the live run, `npm test` completed with **47 passed, 0 failed, 1 skipped**. `npm run check:extension` passed. The skipped test is the old external Microsoft VS Code adapter test.

## Remaining work

- `IMPLEMENTED BUT NOT VERIFIED`: fully automated GUI input. This is a separate investigation and was not used for this acceptance.
- `IMPLEMENTED BUT NOT VERIFIED`: graceful IDE restart/crash recovery of unsaved buffers and disconnected-event durability.
- `NOT IMPLEMENTED`: operator authentication for the local HTTP API.
- `NOT IMPLEMENTED`: production Linux workers, WebRTC, GPU scheduling, and checkpointing.

This verifies the requested Layer 3 human/manual-GUI and multi-agent acceptance path. It does not prove production cloud isolation, crash durability, or the other architectural layers.
