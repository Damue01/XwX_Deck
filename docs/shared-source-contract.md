# Shared source contract

The application uses one common runtime implementation. Edition-specific capabilities live in `src-native/src/edition`, `src/renderer/edition`, `src/shared/edition.ts`, `src/shared/edition`, and `tools/native/edition`.

The default edition retains its empty connection registry, data namespace, fixed Gateway port and release feed. Extensions cannot replace shared pages or protocol implementations through a differing copy of those files.

`docs/shared-core-sync.json` records the complete common runtime and shared build files. Compilation rejects content drift, unregistered runtime files, missing files, downgraded manifests and variant exceptions.

Set the ignored `.shared-core-peer` file or `XWX_SHARED_CORE_PEER` to another checkout to compare it during compilation. Without a counterpart, the gate verifies the embedded baseline and reports `peerVerified: false`.

Preview a change with `node tools/shared-core/sync.mjs --peer PATH --direction export`. Apply it with `--apply --output NEW_EXTERNAL_RECOVERY_DIRECTORY`. Use `import` for the opposite direction. Conflicts, deletions, external edits and export-boundary violations block the batch.

After committing identical shared files in both checkouts, use `--accept-baseline --output NEW_EXTERNAL_RECOVERY_DIRECTORY` to refresh both manifests. Run `node tools/shared-core/audit-parity.mjs --peer=PATH` and each edition's full regression checks before building.

A common-code check does not establish live authorization, installed-client behavior, operating-system interaction or release readiness. Those checks remain separate.
