# `@mistymoon/dsh-mmem`

`@mistymoon/dsh-mmem` is the single installable npm bundle for the standalone dsh-Mmem plugin. It contains the governed Memory runtime, the Memory-owned local DSH principal Adapter, the loopback Settings Host, and the DSH Web Settings tab in one tarball. Runtime data remains outside the package under the active DSH Home.

This alpha is a development preview. It supports Session-bound governed record/Candidate search, filtering, payload-free provenance, append-only Candidate editing/merge, manual review, partial-success batch decisions, exact DSH Workspace-to-Memory-Space bindings, first-use Space setup, and a versioned `manual`/`scheduled-auto` policy editor. The cancellable DST-aware local scheduler uses a cross-process lease and daily payload-free receipts. Its rc.8 Evaluator uses fresh no-tool DSH Agent Sessions, requires durable event receipts, and leaves all Archive authority in a governance runner that revalidates every trusted fact before automatic low-risk decisions. Scheduled review remains off until the Owner explicitly selects `scheduled-auto`.

Memory Spaces default to `isolated`. Owners can choose filtered one-way, read-only, non-transitive Grants in `selective` mode, or explicit non-overlapping Federations in `federated` mode. Borrowed Recall preserves Source Space and authorization receipts, re-applies one global result/character budget, and is discarded if the sharing policy changes during the read.

The bundle also exports the offline standalone migration Module. It provides content-free exact-digest planning, Owner-confirmed apply with an exact target backup, rollback rehearsal, and exact-generation rollback for eligible confirmed rows from the old MistyMoon SQLite store. It does not discover or create DSH Workspaces or Memory Spaces.

## Install after publication

```powershell
dsh plugin --profile web add @mistymoon/dsh-mmem@0.0.1-alpha.0
```

The package is fully verified against DSH `0.1.0-rc.8` and declares the previously verified range `>=0.1.0-rc.7 <0.1.0`. Its root `./client` export and `dsh.client` declaration let the rc.8 Web Host discover the Memory Settings tab. Later DSH release candidates are not claimed until the complete compatibility matrix is rerun.

The package declares its DSH composition layer through `dsh.bundle.patch`; no manual edit to the installed package is required. Review the package and its `cordis.patch.yml` before installation because DSH plugins execute in the Harness process.

Memory archives, settings, Sessions, logs, and credentials are never package assets and must remain under the user's private DSH Home.
