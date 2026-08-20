# Trace session routing decisions

The routing implementation lives in `src/main/trace/sessionRouter.ts`; request fingerprint extraction remains in `sessionBoundary.ts`. This document keeps the historical reasoning out of the persistence layer.

## Stable routing order

1. Native continuation identifiers win: `previous_response_id`, then the client conversation key.
2. Auxiliary title/patch requests use an exact native conversation key, root hash, or interaction id when available.
3. Subagents use pending prompt roots, then a short same-source activity window.
4. Compact resumes and edited Copilot prompts use guarded same-source heuristics.
5. Hidden provisional sessions are absorbed only by a later main turn from the same source.
6. A trace that matches none of the above starts a new session.

## Guardrails retained from production findings

- Source matching is strict. A missing or different source is never treated as a wildcard because concurrent Claude, Codex, and Copilot traffic otherwise crosses session boundaries.
- Title and policy helpers use a 10-minute host window; ordinary auxiliary and subagent fallbacks use two minutes.
- Client-native thread/session keys take precedence over prompt similarity.
- Copilot edit/resend matching requires at least 0.82 trigram similarity, ignores short prompts, and is disabled when a native client conversation key exists.
- Codex structured-output requests without a title schema go to the hidden utility bucket.
- Codex Memory Writing Phase 1/2 and rollout JSON analysis are explicit `memory` auxiliary requests. They attach to an existing visible native conversation owner when possible, otherwise remain hidden.
- When a visible and a hidden Session share the same native client conversation key, the visible Session wins. A newer hidden utility bucket must not steal the key.
- A title that arrives before its main turn becomes a hidden session carrying `pendingUtilityRoots`; only an exact same-source root can absorb it.
- Codex title generators run in their own utility thread and may prepend repository/plugin context as an earlier `user` message. Routing scans user messages from newest to oldest for the `User prompt:` title template instead of assuming the first user message is the template.
- A malformed or future Codex title format without an extractable prompt root fails closed into the hidden utility bucket; it must never attach to the most recent visible Codex task by source alone.
- Claude title generators reuse the main `x-claude-code-session-id`. When a title arrives before the first main request, it becomes a hidden provisional carrying a pending client key; only the exact same-source main key can absorb it. `<session>...</session>` prompt roots remain the fallback for clients that omit the header.
- Every title source fails closed when no exact key/root can be extracted. Title requests never use the recent same-source `auxSource` fallback because a wrong attachment changes the visible session name.
- Auxiliary title/count/subagent requests may retain their request-level client conversation key in the trace record, but only a main turn may establish the session summary's canonical `clientConversationKey`.
- Generic structured-output utility requests are persisted as `auxiliary=utility`; they do not set `firstPrompt`, `firstModel`, `firstClient`, or `lastTurnError`.

The full product/display boundary, live redundancy evidence, logical Conversation grouping design, and provider recovery behavior are documented in [Trace capture, session merging and recovery](trace-capture-session-recovery.md).

These rules came from the June 2026 routing regressions previously documented as dated comments inside `traceStore.ts`.

## Native display-title enrichment

Routing and display titles are separate concerns. Session ownership is still decided
from captured transport evidence, but the dashboard may overlay Codex's own read-only
Thread metadata after routing:

1. An explicit Codex Thread `name` wins.
2. A Codex `title` wins only when it differs from `first_user_message`; an identical
   value is Codex's fallback preview, not a generated title.
3. XwX's captured title response remains the network fallback.
4. `firstPrompt` remains the final display fallback.

The adapter reads `state_5.sqlite` from the normal Codex home and any configured
`sqlite_home` / `CODEX_SQLITE_HOME`. It never writes the Codex database or persists
the overlay into XwX's `index.json`.
