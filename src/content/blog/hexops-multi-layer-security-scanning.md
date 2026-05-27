---
title: 'The Lockfile Scanner Said Clean. Grype Said Forty-One. Both Were Right.'
description: 'A security tool that runs one scanner is lying to you. Real coverage requires multiple scanners operating at different layers of the same system, and the UI has to make their disagreement legible. How HexOps now runs three scanners concurrently, treats their divergence as information, and tracks every Apply as a change-control event.'
pubDate: '2026-05-27T12:00:00-04:00'
author: 'Aaron Lamb, Hexaxia Labs'
---

A managed project in HexOps named hexmetrics scans clean against pnpm audit. Scans clean against [cve-lite](https://owasp.org/cve-lite-cli). And shows forty-one findings from [grype](https://github.com/anchore/grype).

The instinct is to assume one of the scanners is broken. Pick the one you trust, fix the others. Instead, what is actually happening is the cleaner story: all three scanners are correct, and they are correct about different things. The lockfile scanners cannot see what grype is finding, and grype cannot trace what it found back to anything the lockfile scanners would care about.

That insight rewrote how we think about the HexOps security stack. The site now runs three scanners concurrently per project plus an install-gate plugin, treats source disagreement as expected behavior, lets the user remediate findings via multiple paths, tracks exceptions with full audit trail, and logs every Apply as a change-control record.

This is what we learned getting there.

## Three scanners, three fields of view

A single scanner has a single field of view. Different scanners have different fields of view by design. Picking only one means accepting the blind spots of one. The HexOps stack runs three scanners against the same project, in parallel, plus a fourth tool that does something the others cannot.

### pnpm audit

Reads `pnpm-lock.yaml`. Looks up each package version in the npm advisory database, the first-party advisory feed maintained by GitHub. Catches anything in that database. Misses anything outside it: non-npm artifacts, embedded binaries, and CVEs that have not been ingested into the npm advisory DB yet.

### cve-lite

Reads `pnpm-lock.yaml` or `package-lock.json`. Looks up each package version against [OSV](https://osv.dev), the open multi-ecosystem advisory database. Same surface as pnpm audit but a different upstream feed, so it sometimes catches things the npm advisory DB has not ingested yet. Same blind spot as pnpm audit for anything not in a lockfile.

### grype

Reads the filesystem. Recursively walks `node_modules` and beyond, uses Syft to identify every package type it finds (npm, Go, Python, Rust, Java, Ruby, more), and matches each against NVD plus GHSA plus OSV. Catches embedded binaries, vendored libraries, multi-ecosystem npm packages that ship native modules, and container layers if pointed at an image. The trade: it cannot correlate a finding back to a lockfile choice. It just reports what it found on disk.

### Aikido Safe Chain (install gate, not a scanner)

Intercepts outgoing install requests to the package registry. Looks up the request against Aikido's threat intel and blocks malicious packages: typosquats, recently compromised maintainers, known-bad. Different threat model entirely: active supply-chain attack, not existing installed vulnerabilities. It does not scan, it intercepts.

The lockfile scanners and the filesystem scanner are scanning different things. They are not redundant. Their disagreement is information.

```
┌─────────────────────────────────────────────────────────────────┐
│                    HexOps Security Scan                          │
│                                                                  │
│   ┌──────────────┐  ┌──────────────┐  ┌──────────────────┐      │
│   │  pnpm audit  │  │  cve-lite    │  │     grype        │      │
│   │              │  │              │  │                  │      │
│   │  reads:      │  │  reads:      │  │  reads:          │      │
│   │  pnpm-lock   │  │  pnpm-lock   │  │  the filesystem  │      │
│   │              │  │              │  │  (incl. binaries)│      │
│   │  source:     │  │  source:     │  │  source:         │      │
│   │  npm         │  │  OSV         │  │  NVD + GHSA      │      │
│   │  advisories  │  │  (multi-eco) │  │  + OSV (Syft)    │      │
│   └──────┬───────┘  └──────┬───────┘  └────────┬─────────┘      │
│          │                  │                    │                │
│          └──────────┬───────┴───────────┬───────┘                │
│                     ▼                   ▼                         │
│              mergeFindings()    activeExceptions filter           │
│                     │                   │                         │
│                     ▼                   ▼                         │
│              UI: severity pills + per-project rows                │
│                                                                   │
│   ┌──────────────────────────────────────────────────┐           │
│   │  SafeChainPlugin  (install gate, not a scanner)  │           │
│   │  intercepts pnpm install / npm install at apply  │           │
│   │  time. Different threat model: malicious deps    │           │
│   │  (typosquats, compromised maintainers) vs CVEs.  │           │
│   └──────────────────────────────────────────────────┘           │
└─────────────────────────────────────────────────────────────────┘
```

## The case study that made it click

Back to hexmetrics. Zero from pnpm audit. Zero from cve-lite. Forty-one from grype. Inspecting the grype data:

```
package: stdlib@go1.23.12
path:    /node_modules/esbuild/bin/esbuild
sources: ['grype']
title:   CVE-2026-39820 + 40 other Go stdlib CVEs
fixedIn: 1.24.8, 1.24.9, ..., 1.25.10  (Go versions, not npm)
```

What is actually happening:

- esbuild's npm package ships a Go binary at `node_modules/esbuild/bin/esbuild` (or, in newer esbuild, at `@esbuild/<platform>-<arch>/bin/`).
- grype walks the filesystem, hits the Go binary, parses the embedded Go module info, extracts `go1.23.12`, and matches it against every Go stdlib CVE published since.
- pnpm audit reads the lockfile, sees `esbuild@0.25.12`, looks up "npm package esbuild version 0.25.12" in the npm advisory DB, gets nothing, reports clean.
- cve-lite does the same thing against OSV's npm namespace, also reports clean.

All three scanners are doing exactly what they are designed to do. The npm package `esbuild` has no advisory against version 0.25.12. The Go binary it ships has forty-one. The lockfile scanners cannot see inside binaries; the filesystem scanner cannot trace a finding back to a lockfile choice.

This is why the per-source cards in the HexOps `/security` UI now carry scope labels (`lockfile scanner` or `filesystem/binary scanner`), and why source disagreement is treated as expected behavior with a divergence indicator on individual findings instead of as a bug to suppress.

## What each scanner sees that the others miss

Beyond Go binaries inside esbuild, grype catches:

- Native node modules with embedded C, Rust, or Go code (sharp, sqlite3, swc native, oxide)
- Vendored libraries committed directly into a repo
- Container layers when grype is pointed at an image instead of a directory (same scanner, different input)
- Linux system packages when scanning system paths
- Python wheels, Java JARs, Ruby gems when those leak into a primarily-npm project

For hexmetrics, grype is the only scanner that surfaces the Go binary issue. For a typical Next.js project, grype will mostly overlap with pnpm audit on JS findings, with the binary-only findings being the unique value.

The lockfile scanners have their own signal that grype cannot match:

- Transitive dependency graph context. They know which advisories apply to which transitive paths through the dep tree. Grype just sees a vulnerable copy on disk.
- Validated fix versions. cve-lite specifically returns `validatedFixVersion` plus `runnableFixCommand` for each advisory, so the user has a clear "bump X to Y" path. Grype gives `fixedIn` as a string, which sometimes maps to an npm package version and sometimes (Go binary case) does not.
- Direct versus transitive classification. Lockfile scanners can identify whether a vulnerable package is in your direct deps or buried four levels deep. Grype just reports the path on disk.

Neither layer subsumes the other. Both are needed.

## Why merging matters

Without merging, the UI would show three independent finding lists per project, and the user would have to mentally cross-reference. That is a tax most operators will not pay. They will pick one scanner to trust and ignore the other two, which means accepting the blind spots of whichever they picked.

The `mergeFindings` step does three things:

1. **Dedup by canonical advisory ID.** A finding with `CVE-2026-39820` is the same finding whether pnpm audit or grype reported it.
2. **Reconcile severity.** Different scanners sometimes disagree on severity (NVD says high, GitHub says critical). The merger picks the highest reported, preserving the source of truth in `rawBySource` for inspection.
3. **Track divergence.** When the same finding is reported by some scanners but not others (which is most findings, given how different the scanning layers are), the merged record carries a `divergent` flag. The UI surfaces it as a small badge so the user can see at a glance "this is reported by only one scanner." A divergent finding is more likely to be a false positive or a unique-coverage gap, either of which warrants closer attention.

The merged view drives the per-project severity pills, the fleet aggregate, and the "All findings" list inside each accordion row. Per-source counts remain visible above the list so the user can drill down to what each scanner specifically contributed.

## What we learned about fixing things

The temptation when you click Apply on a finding is to make the experience feel simple: Apply Fix, then Done. Real remediation is messier than that.

### Not every finding has a fix yet

Back to hexmetrics. The user bumps `@esbuild/linux-x64` to `latest`, which resolves to 0.25.12. The new latest still ships a Go 1.23.12 binary. The fix landed correctly. The vulnerability persisted because esbuild's maintainers have not released a build with a newer Go yet.

If the UI had just closed the dialog and said "Applied," the user would walk away thinking the issue was fixed when it is not. The system would silently lose forty-one vulnerabilities.

So every Apply now runs a verify phase after the install. The merged-findings cache is re-pulled, the targeted group's `dedupKey`s are re-checked, and the dialog reports one of:

- **resolved**: every targeted finding is gone. Green check.
- **partial**: some cleared, some remain. Amber warning. The "File exception for remaining" shortcut appears.
- **unresolved**: none cleared (the hexmetrics case). Amber warning with explanatory copy: "the upstream maintainer may not have shipped a release that resolves this advisory." Shortcut to File Exception.
- **error**: install or rescan threw. Red error with the message.

The user always sees the actual state, not the wishful state.

### Grype findings need parent-package grouping

The first cut of the "All findings" list showed forty-one individual stdlib CVE rows for hexmetrics. That is the truth of what grype found, and it is useless. The actionable unit is the parent npm package that ships the vulnerable binary, not the binary's reported package.

`deriveParentPackage(finding)` parses the path field: `/node_modules/esbuild/bin/esbuild` becomes `esbuild`. Forty-one stdlib findings collapse into one `esbuild via stdlib` row. The user sees one actionable surface, not forty-one noise rows.

For findings whose parent npm package matches the reported package (the normal lockfile-finding case), the grouping degenerates to the existing `package@version` grouping. No behavior change for those.

### Multiple remediation paths, not one button

A real security tool does not say "click here to fix it." It says: here is what is wrong, here are your options, here is the audit trail. The HexOps RemediationPanel surfaces:

1. **Apply fix.** Bump the package to a target version (pre-filled with grype's `fixedIn` for direct matches, or `latest` for parent-embedded). Submits via `/update`. Pending-commit banner opens.
2. **Override pin.** Same dialog, override checkbox pre-checked. Writes a `pnpm.overrides` or npm `overrides` or yarn `resolutions` entry. The only viable path for deeply nested transitive deps where bumping the direct dep does not dislodge the nested copy (the postcss-under-Next pattern that has bitten this project before).
3. **Send to Patches.** Deep-link to the Patches page. Richer workflow (hold, escalate, batch apply) maintained by pnpm-audit's pipeline.
4. **View references.** Modal listing every advisory URL across the group's CVEs. NVD, GHSA, vendor pages. The user can read the actual vulnerability before deciding.
5. **File exception.** See the next section.

Different findings warrant different paths. The UI gives the user the menu.

## Suppression is a four-letter word

"Hide this finding so I do not have to look at it again" is exactly what an attacker wants you to do. The right framing is exception or deviation tracking, not suppression.

The `SecurityException` model HexOps now uses:

- **Classification is mandatory.** One of `risk-accepted`, `false-positive`, `compensating-control`, `deferred`, `unfixable`, `deviation`. The user has to declare why they are choosing not to fix.
- **Reason is mandatory.** Free-text justification, captured in the audit log.
- **Expiry is supported.** Default ninety days. After expiry the exception lapses and the finding reappears. Forces periodic re-evaluation. Prevents accepted risk from becoming forgotten risk.
- **Revoke is a soft delete.** Revoked exceptions stay in history with `revokedAt`, `revokedBy`, `revokeReason`. The audit trail is preserved across re-litigation.
- **Edit is supported.** Change classification, reason, notes, or expiry without revoking and re-filing. The `remediation_modified` audit entry captures the diff.
- **Storage is durable.** `.hexops/exceptions-<projectId>.json`, not under `cache/`. Cache wipes do not lose exceptions.
- **Aggregate filtering.** Once filed and active, the exception's parent package drops out of fleet severity pills, the SummaryBar, and the merged findings list. This is the only legitimate "suppression," and it is only legitimate because the trail exists.

Exceptions are visually loud in the UI (amber section, exception count chip on the collapsed project row) because accepted risk should be obvious, not hidden. A reviewer needs to be able to see at a glance "this project has three accepted-risk items" before approving anything else about it.

## Two plugin tracks, two contracts

The same session also introduced a two-track plugin architecture:

1. **Existing `ScanSource` track** (pnpm-audit, grype, cve-lite). Post-hoc scanners that read state and return structured findings. Untouched.
2. **New `SecurityPlugin` track**. Capability-typed plugins for tools that do not fit the scanner shape:
   - `installGate` (Safe Chain). Intercepts install commands at apply time. Different threat model entirely: active supply-chain attack versus existing vulnerabilities.
   - `complianceAudit` (future). Bodadotsh-style checklist audit. Checks config and workflow against best-practice rules.

The two tracks compose at the UI level: both surface as cards on the per-project row. But they have distinct contracts because they do distinct things. Forcing Safe Chain into the `ScanSource` shape would have meant either lying about its output (it does not produce structured findings) or contorting `ScanSource` to fit a square peg. Two tracks, two contracts, no contortion.

## What this changes

A security tool that is pleasant to use is a security tool that gets used. Most security UIs treat the user as someone to be policed. HexOps's `/security` treats the user as someone to be informed and equipped. The difference is concrete:

- The scanners disagree. Tell the user why.
- Not every finding is fixable. Say so, surface the alternative.
- Suppressing a finding requires a tracked exception. Make filing one a click, not a chore.

The result is a security tool that documents what is happening in your codebase instead of one that you fight with until you ignore it.

The lockfile scanner says clean. Grype says forty-one. Both are right. The job of the tool is to make that clear, not hide it.

The other half of this story is what the system does when you click Apply. The hexmetrics case is the bait: the Apply succeeds at the install layer, the CVEs persist anyway. How HexOps knows that, logs it, and lets you cite it in an incident report or compliance audit is a different architectural commitment with its own depth. That writeup is the follow-up post: [The Apply Succeeded. The CVEs Persisted. The Log Knew.](/blog/hexops-change-control-logging/)

---

HexOps is open source. Source at [github.com/Hexaxia-Labs/hexops](https://github.com/Hexaxia-Labs/hexops). MIT license.

Aaron Lamb
Co-Founder, [Hexaxia Technologies](https://www.hexaxia.tech/)
