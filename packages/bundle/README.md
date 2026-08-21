# `@mistymoon/dsh-mmem`

`@mistymoon/dsh-mmem` is the single installable npm bundle for the standalone dsh-Mmem plugin: Owner-governed long-term memory for DeepSeek Harness (DSH). It includes the Memory runtime, local DSH principal adapter, loopback Settings Host, and DSH Web Settings tab. Runtime data stays outside the package in the active private DSH Home.

> Current release: public alpha `0.0.1-alpha.0`. It is fully verified against DSH `0.1.0-rc.8`; packed installation and Web Settings discovery were also verified on `0.1.0-rc.7`. Test with neutral or recoverable data before using it for an irreplaceable archive.

## Install or download

Requirements:

- Node.js `^22.19.0 || >=24.0.0`
- DSH `>=0.1.0-rc.7 <0.1.0`
- DSH `0.1.0-rc.8` recommended

Install the exact verified version through DSH:

```powershell
dsh plugin --profile web add @mistymoon/dsh-mmem@0.0.1-alpha.0
```

Follow the alpha dist-tag:

```powershell
dsh plugin --profile web add @mistymoon/dsh-mmem@alpha
```

Download the package as a `.tgz` without installing it:

```powershell
npm pack @mistymoon/dsh-mmem@0.0.1-alpha.0
```

Integrators who manage their own Cordis/DSH composition can install it as a dependency:

```powershell
npm install @mistymoon/dsh-mmem@0.0.1-alpha.0
```

The package declares its DSH composition through `dsh.bundle.patch`, including the Host entries and rc.8-compatible root Web client discovery. A normal DSH plugin installation does not require editing the installed package. Review this package and its `cordis.patch.yml` first because DSH plugins execute inside the Harness process.

## First use

1. Open a live Session in the target DSH Workspace.
2. Open Memory Settings.
3. Create a Memory Space or bind an existing Space to that Workspace.
4. Choose read-only or read-write access and, when needed, select one Default Write Space.
5. Keep the default `manual` review policy or explicitly configure `scheduled-auto` with an IANA time zone and local review time.

DSH remains the only authority for Workspace identity. dsh-Mmem accepts the exact `SessionHeader.cwd` from a live Session; the browser cannot submit an Owner, `cwd`, arbitrary Workspace, or Archive path.

## Highlights

- Owner-, scope-, visibility-, and source-governed confirmed memory with append-only revision lineage.
- Session-bound record/Candidate search, filtering, provenance, editing, merge, conflict handling, manual review, and partial-success batch decisions.
- Physically isolated Memory Spaces; one Space may intentionally serve multiple DSH Workspaces.
- `isolated`, filtered one-way `selective`, and explicit `federated` inter-Space recall.
- Borrowed Recall that preserves Source Space and authorization receipts and is discarded if policy changes during the read.
- Versioned `manual` / `scheduled-auto` policy with IANA time zones, DST-aware local scheduling, cross-process lease, and daily payload-free receipts.
- Fresh no-parent/no-seed/no-tool DSH Agent Sessions for scheduled recommendations, followed by governance revalidation before any low-risk decision.
- Content-free exact-digest planning and explicit apply/rehearse/rollback workflow for eligible confirmed rows in the old MistyMoon SQLite store.

Pending, rejected, imported-draft, cross-Owner/scope, or undisclosed content never enters recall. Recall snapshots visible to the model are persisted in DSH Session logs. CI/CD uses neutral fixtures only; scheduled review runs locally in the user's DSH Runtime and never requires cloud CI to read a private DSH Home.

## Memory Space sharing

| Mode | Cross-Space behavior |
| --- | --- |
| `isolated` | Recall only from the current Active Space. |
| `selective` | Follow explicit one-way, read-only, non-transitive Grants filtered by Memory Kind and visibility. |
| `federated` | Recall among explicitly listed Federation members; new Spaces never join automatically. |

Sharing changes read-only recall, not ownership or Workspace Bindings. Borrowed items cannot be mutated through the Active Space facade.

## Scheduled review safety

`manual` is the default and no scheduler runs until the Owner explicitly saves `scheduled-auto`. Malformed or low-confidence evaluator output, failures, `boundary` or `commitment` kinds, blocking conflicts, and any changed policy/Owner/Binding/Space/Candidate/source state are deferred to manual review. The evaluator receives no Archive mutation authority.

## Data and current limitations

Memory archives, settings, Sessions, logs, and credentials are never package assets. The default `local-dsh-host-rpc` authority is limited to a loopback Web, single-Owner deployment. Other channels fail closed until they provide an authenticated principal adapter.

No candidate-extraction Provider is bundled by default; governed DSH tools can still propose Candidates. Recall defaults to local BM25, while PageIndex and graph adapters are disabled by default. Later DSH release candidates and stable releases are not claimed until the full compatibility matrix is rerun.

The plugin and repository use the MIT License. See the [GitHub repository](https://github.com/mianyoubiaoqing/dsh-Mmem) for architecture, migration commands, release validation, ecosystem research, and issue reporting.
