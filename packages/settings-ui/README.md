# `@mistymoon/dsh-memory-settings-ui`

This package contributes the standalone dsh-Mmem page to DSH's `settings.plugins.tab` slot. It reads the current Session only through DSH's public Session-list hook, then creates a Session-bound `@mistymoon/dsh-memory/settings-client` caller. The page never accepts Owner identity, `cwd`, an arbitrary Workspace, or Archive paths.

The current MVP displays the exact Active Memory Space and Binding access, lists pending Candidates, supports manual approval and rejection, and requires an explicit keep-both or supersede choice for blocking duplicate/conflict assessments. A missing current Session fails closed, and a read-only Binding disables all writes.

The Host marker owns no Memory data or RPC behavior. `@mistymoon/dsh-memory/settings-host` remains the loopback transport authority, and `MemorySpaceGovernanceResolverV1` remains the only route to an Active Space.

Search filters, provenance display, Candidate edit/merge, partial-success batch review, Space selection, and scheduled-auto configuration are still follow-up UI work.
