# dsh-Mmem Settings UI workspace

This private workspace package contributes the standalone dsh-Mmem page to DSH's `settings.plugins.tab` slot. Its built Host and browser entries ship through `@mistymoon/dsh-mmem/settings-ui` in the single public npm bundle. It reads the current Session only through DSH's public Session-list hook, then creates a Session-bound Memory Settings caller. The page never accepts Owner identity, `cwd`, an arbitrary Workspace, or Archive paths.

The current MVP displays the exact Active Memory Space and Binding access, applies content/kind/visibility/status filters through the governed Session-bound search, lists matching governed records and Candidates, shows payload-free Observation/revision lineage, edits or explicitly merges Candidates by creating append-only replacements, supports manual approval and rejection, and requires an explicit keep-both or supersede choice for blocking duplicate/conflict assessments. A missing current Session fails closed, and a read-only Binding disables all writes while keeping source inspection available.

The Host marker owns no Memory data or RPC behavior. `@mistymoon/dsh-memory/settings-host` remains the loopback transport authority, and `MemorySpaceGovernanceResolverV1` remains the only route to an Active Space.

Partial-success batch review, Space selection, and scheduled-auto configuration are still follow-up UI work.
