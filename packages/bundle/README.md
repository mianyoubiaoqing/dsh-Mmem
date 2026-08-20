# `@mistymoon/dsh-mmem`

`@mistymoon/dsh-mmem` is the single installable npm bundle for the standalone dsh-Mmem plugin. It contains the governed Memory runtime, the temporary local Owner adapter, the loopback Settings Host, and the DSH Web Settings tab in one tarball. Runtime data remains outside the package under the active DSH Home.

This alpha is a development preview. It supports Session-bound governed record/Candidate search, filtering, payload-free provenance, and manual review plus exact DSH Workspace-to-Memory-Space bindings. Scheduled auto-review, the final Memory-owned principal resolver, and cross-Space sharing are not complete.

## Install after publication

```powershell
dsh plugin --profile web add @mistymoon/dsh-mmem@0.0.1-alpha.0
```

The package declares its DSH composition layer through `dsh.bundle.patch`; no manual edit to the installed package is required. Review the package and its `cordis.patch.yml` before installation because DSH plugins execute in the Harness process.

Memory archives, settings, Sessions, logs, and credentials are never package assets and must remain under the user's private DSH Home.
