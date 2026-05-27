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

A single scanner has a single field of view. Different scanners have different fields of view by design. Picking only one means accepting the blind spots of one.

| Scanner | Reads | Looks for | Covers | Misses |
|---|---|---|---|---|
| **pnpm audit** | `pnpm-lock.yaml` | Package versions in npm advisory DB | First-party npm vuln coverage maintained by GitHub | Anything not in the npm advisory DB; non-npm artifacts; embedded binaries |
| **cve-lite** | `pnpm-lock.yaml` or `package-lock.json` | Package versions in OSV (multi-ecosystem advisory DB) | Cross-ecosystem npm coverage; sometimes catches things npm advisory has not ingested yet | Same blind spot as pnpm-audit for non-lockfile content |
| **grype** | The filesystem (recursively walks `node_modules` and beyond, using Syft to identify all package types) | NVD plus GHSA plus OSV across all ecosystems Syft recognizes (npm, Go, Python, Rust, Java, Ruby, and more) | Embedded binaries; vendored libraries; multi-ecosystem npm packages that ship native modules; container-style scans | Nothing on lockfile correlation: finds stuff in binaries it cannot trace back to a lockfile entry |
| **Aikido Safe Chain** | Outgoing install requests to the package registry | Malicious packages (typosquats, recently compromised maintainers, known-bad) using Aikido's threat intel | Active-attack supply-chain threats: a different threat model entirely | Existing installed vulnerabilities; does not scan, intercepts |

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

## Logging is the load-bearing primitive

A security tool that mutates code or state without leaving a trail is worse than no security tool. The reason is concrete, not abstract. Three failure modes appear the moment the trail is missing:

- **Compliance failure.** SOC 2, ISO 27001, HIPAA, FedRAMP, and every other framework that touches software security requires that "changes affecting security-relevant configuration" are logged with who, when, what, why, and what was the outcome. A tool that applies vulnerability fixes without producing that record makes its operators unable to attest to those controls. The auditor does not accept "we use HexOps, it is secure." They ask "show me the change log for every vulnerability remediation in the last quarter."
- **Incident-response failure.** When a production incident traces back to a recent dependency change, the question is "what did we touch?" If the answer is "I think someone applied a fix to esbuild last Tuesday but I am not sure exactly what changed or whether it worked," that is an incident-response failure on top of the original incident. The investigation reconstructs intent from git logs plus memory plus Slack scrollback. That is slow, error-prone, and traumatic.
- **Accountability failure.** Without a log, "who applied this fix" cannot be answered. In a single-user dev environment, this is academic. In any multi-operator team, accountability requires a trail. Otherwise the question "did we know about this CVE when we deployed?" cannot be answered, which means liability cannot be apportioned, which means lessons cannot be learned and applied to process.

This is why the HexOps logging is the deepest architectural commitment in the security stack. Every other piece of state (the merged findings cache, the exceptions file, the finding-states index) can be regenerated from logs plus scanner re-runs. The log itself cannot be regenerated. It is the irreducible record.

### Every Apply is a change-control event

Before this work, HexOps logged the successful completion of an Apply (`security_remediation_applied` under the patches log category). That is not nothing, but it is incomplete. Failed Apply attempts left no trace. The intent (what was being attempted, with what parameters) was not logged before the install, only as part of the success record. There was no way to thread "the Apply at 14:32" to "the rescan at 14:34" to "the result the user saw at 14:35."

The new model: every Apply gets a generated `attemptId` (for example, `rem_8f3a2b09…`). Every log event for that attempt carries the same `attemptId` in its meta. Grep the security log by attempt ID and you reconstruct the full lifecycle.

```
[14:32:01] remediation_initiated         attemptId=rem_abc123…
                                          source=grype
                                          parameters: {
                                            packages: [{name: "@esbuild/linux-x64", from: "0.25.10", to: "latest"}],
                                            advisoryIds: [CVE-2026-39820, ...],
                                            severity: high,
                                            fixViaOverride: false,
                                          }

[14:32:47] remediation_install_complete  attemptId=rem_abc123…
                                          packages: [@esbuild/linux-x64]
                                          installGate: { plugin: safe-chain, binOverride: aikido-pnpm }

[14:33:42] remediation_completed         attemptId=rem_abc123…
                                          outcome: {
                                            status: unresolved,
                                            previousFindingCount: 41,
                                            currentFindingCount: 41,
                                            findingsCovered: [CVE-2026-39820, ...41 keys...],
                                            findingsResolved: [],
                                            findingsRemaining: [CVE-2026-39820, ...41 keys...]
                                          }
```

Both Apply paths in HexOps (the grype RemediationPanel and cve-lite's `applyOne` / `fixAll`) now flow through this same shape. The `attemptId` is generated client-side, threaded through `auditContext.attemptId` to `/update` or `/api/security/cve-lite/[id]/fix`, and the final outcome is posted to `/api/projects/[id]/security/remediation/[attemptId]/complete` after the verify phase. One logging contract, two remediation paths, no orphan paths.

Failures get the same treatment. `remediation_install_failed` if the install errored. `remediation_completed` with `outcome.status: 'error'` if the rescan or verify threw. A clean audit log is one where every `remediation_initiated` has a matching `remediation_completed` or `remediation_install_failed` downstream. Orphan `initiated` events without resolution are the things you investigate.

The dialog surfaces the tracking ID in the outcome panel so the user has a change-control reference to cite in an incident report or a compliance audit.

### Why naive logging falls short

There is a tempting middle-ground design: just log the result of each Apply. "Hey, esbuild was bumped to 0.25.12 on May 27 at 14:32." That is a log entry. It is not audit-grade. Four things it hides:

- **It hides intent.** The user clicked Apply intending to resolve 41 CVEs. The bump happened correctly. But the bump did not resolve the CVEs (the Go binary case). A naive log shows "esbuild bumped" and an auditor reading it would think the fix worked. A change-control log shows "intent: resolve 41 CVEs; outcome: 0 resolved; status: unresolved" and they see the truth.
- **It hides failure.** A naive log only fires on success. Failed Apply attempts leave no trace. An attacker who deliberately tries to apply something malicious and gets blocked is invisible. A change-control log fires on both `remediation_initiated` (before anything happens) and `remediation_install_failed` (when it goes wrong), so the trail captures attempts even when they do not succeed.
- **It hides parameters.** A naive log says "esbuild bumped to 0.25.12." A change-control log says "esbuild bumped from 0.25.10 to 0.25.12 via direct install (not override), under audit context source=grype with advisories CVE-2026-39820 plus 40 others, severity=high." You can answer "what versions transitioned" or "did we use an override pin" without rerunning the analysis.
- **It hides correlation.** Naive logging makes it hard to thread "the apply at 14:32" to "the rescan at 14:33" to "the finding that disappeared at 14:34." You are correlating timestamps and hoping nothing else ran in those windows. The `attemptId` makes it one grep.

Naive logging answers "did something happen?" Change-control logging answers "what was the full lifecycle of this specific decision?" Those are different questions, and only the second one is audit-grade.

### Four events, none redundant

Every Apply produces up to four log events. None is duplicative.

```
remediation_initiated  →  remediation_install_complete  →  remediation_completed
                                       OR
                          remediation_install_failed
```

**`remediation_initiated`** fires before the install runs, with the full parameters. This is the intent record. It exists even if the install never executes (network failure, server crash, kill switch flipped). Without it, you cannot detect attempted-but-never-executed Apply operations: operations that timed out, operations the server crashed during, operations where the user clicked Apply but the API never received the request. The initiated event is also the only one that captures the full input; subsequent events reference it by attemptId but do not duplicate the parameters.

**`remediation_install_complete`** or **`remediation_install_failed`** fires when the install pipeline reaches a terminal state. This is the execution record. Distinct from intent because the install might run with different parameters than intended (lockfile reconciliation forces a different version), might fail partway through having mutated some state but not others, or might invoke an install-gate plugin (Safe Chain) that blocks specific packages and requires different downstream interpretation. This event captures what actually happened on the server, distinct from what the user asked for.

**`remediation_completed`** fires after the post-install rescan and verify complete. This is the outcome record. The key insight: an Apply that succeeds at the install layer can still fail at the outcome layer (the hexmetrics esbuild case again). Or partially succeed. The outcome event is the only place that distinguishes these. Without it, the audit log shows "successful install" but cannot answer "did the fix resolve the vulnerabilities?" That is the question an auditor or post-mortem investigator most cares about.

### What attemptId threading lets you query

Because every event for an Apply attempt shares the same `attemptId`, the log becomes queryable as a graph, not just a stream. Concrete operations the threading enables:

- **"Show me every Apply attempt on this project last week."** Grep `remediation_initiated` filtered by date, then for each match grep the same attemptId across the rest of the log to assemble the lifecycle.
- **"Show me every Apply attempt that failed."** Grep `remediation_initiated` for the intent set, grep `remediation_install_failed` for the failure set, the difference is "in-flight, abandoned, orphaned." Itself an interesting signal.
- **"Show me every fix attempt that did not actually resolve findings."** Grep `remediation_completed.*"status":"unresolved"`. Directly answers "what fixes did we try that did not work?" Useful for engineering debrief (why?) and accountability (we tried, we documented, we filed exceptions).
- **"Reconstruct the security state of this project at any point in time."** Replay `finding_detected` plus `finding_resolved` events up to a given timestamp. Lets you answer "what did we know about, when?" The central question of every post-mortem.
- **"What is the time-to-remediate for critical findings on this project?"** Pair `finding_detected` events with their eventual `remediation_completed` events (matched by `findingsCovered` containing the dedupKey). Compute deltas. That is a real MTTR metric, derivable from the log, with no separate metrics infrastructure required.

None of these are possible if the log entries do not share an ID. All of them are trivially possible because they do.

### Finding lifecycle and the silent-disappearance problem

Independent of Apply attempts, every scan emits `finding_detected`, `finding_redetected`, or `finding_resolved` events when the diff against the previous scan reveals new, returned, or vanished findings. Each event carries the dedupKey, severity, package, sources, and advisory IDs. The "first seen N days ago" chip on each finding row in the UI is derived from this index. Findings detected in the last twenty-four hours get a `new` chip.

The problem this solves: **findings can vanish for reasons other than "we fixed them."** Concretely:

- A scanner could stop detecting a CVE because its advisory data lags upstream
- A scanner could fail silently (timeout, network glitch, cache corruption) and return fewer findings
- A package could be removed entirely from the project: the vulnerability is gone but no fix was applied
- A new version of a scanner could change its detection logic: same code, different finding set
- A grype DB refresh could move CVEs around

Without diff logging, all of these look identical to "successful remediation." A finding that was there yesterday is gone today, the dashboard shows zero, everyone celebrates, and three months later someone discovers that the vulnerable code is still in production. The scanner just stopped catching it.

`finding_resolved` events let you correlate vanished findings with explicit remediation attempts. If a `finding_resolved` event fires within minutes of a `remediation_completed` event for the same dedupKey, you have high confidence the fix worked. If a `finding_resolved` event fires with no recent `remediation_completed` correlating to it, that is worth investigating. The finding silently disappeared.

`finding_redetected` is the regression-alert pathway. A finding we thought was resolved is back. Why? Did the fix get reverted? Did the scanner change? Is the dep tree different on a different machine? The event itself does not answer; it raises the question that needs answering, in the same audit log that already contains the original detection and the original resolution.

### The audit-log-as-source-of-truth principle

The deepest design principle behind all of this is: **the log file is the source of truth for what has happened in the system, period.** Not the database. Not the in-memory state. Not the cache. The log.

Every other piece of state in the security stack can be regenerated from logs plus scanner re-runs. The log is the irreducible record. This shapes design decisions in concrete ways:

- Caches can be aggressively invalidated because re-deriving them from scans is the path. The log persists across invalidations.
- Crashes and partial states do not lose audit information because the log is append-only and survives every other state's corruption.
- Migration of derived state (such as exception schema changes) does not require log migration. The log is the contract.

Practical consequence: never put information in the cache or in-memory state that does not also flow through the log. If it is not logged, it did not happen. For a security tool, that is an absolute statement.

The cost of this discipline is rounding-error compared to the value. Each Apply generates 3 to 4 log entries at ~1KB each. A team applying 50 fixes per week generates ~10MB per year. Performance overhead is fire-and-forget through the existing `logger.info` machinery, no new IO patterns. Cognitive load on operators is zero (the logging is invisible until you want it). Compared to losing the ability to attest to compliance, respond to incidents, or apportion accountability, the trade is not close.

This pattern is table stakes for established tools (Snyk, Dependabot, GitHub Advanced Security, Aikido, Mend all log every action against a tracked finding ID). The HexOps implementation deliberately patterns after how those tools log. What we are doing is bringing that pattern to a self-hosted, local-first dev tool that did not have it. HexOps users get the same auditability that enterprises get from Snyk, without sending their dependency data to a vendor.

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
- Every Apply is a change-control event. Log it richly, surface the tracking ID, let the user cite it in incident reports.

The result is a security tool that documents what is happening in your codebase instead of one that you fight with until you ignore it.

The lockfile scanner says clean. Grype says forty-one. Both are right. The job of the tool is to make that clear, not hide it.

---

HexOps is open source. Source at [github.com/Hexaxia-Labs/hexops](https://github.com/Hexaxia-Labs/hexops). MIT license.

Aaron Lamb
Co-Founder, [Hexaxia Technologies](https://www.hexaxia.tech/)
