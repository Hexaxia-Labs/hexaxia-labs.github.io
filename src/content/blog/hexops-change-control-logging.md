---
title: 'The Apply Succeeded. The CVEs Persisted. The Log Knew.'
description: 'A vulnerability remediation that succeeds at the install layer can fail at the outcome layer, and a security tool that does not distinguish these is lying to its operator. How HexOps logs every Apply as a change-control event with full attemptId-threaded lifecycle, why naive logging falls short, and the audit-log-as-source-of-truth principle behind it.'
pubDate: '2026-05-27T12:00:00-04:00'
author: 'Aaron Lamb, Hexaxia Labs'
---

A managed project named hexmetrics in HexOps shows forty-one grype findings against a Go binary embedded in esbuild. The user clicks Apply. The `@esbuild/linux-x64` package bumps cleanly from 0.25.10 to the published latest. The install succeeds. The findings persist anyway, because esbuild's maintainers have not yet released a build with a newer Go stdlib.

A naive remediation log captures "esbuild bumped to 0.25.12, applied successfully." Three months later when an auditor or post-mortem investigator asks "what did we know about CVE-2026-39820 in May, and what did we do about it?" that log answers wrong. It says the fix worked. It did not.

The hexmetrics case is the visible tip of an architectural question every security tool eventually answers, either deliberately or by accident: **what does the system remember about an Apply attempt, and is that record sufficient to attest to compliance, respond to an incident, or apportion accountability?**

This is the writeup for how HexOps answers that question. The companion post on the multi-scanner architecture that surfaces the hexmetrics case in the first place is over [here](/blog/hexops-multi-layer-security-scanning/).

## Three failure modes a security tool creates without a trail

A security tool that mutates code or state without leaving a trail is worse than no security tool. The reason is concrete. Three failure modes appear the moment the trail is missing:

- **Compliance failure.** SOC 2, ISO 27001, HIPAA, FedRAMP, and every other framework that touches software security requires that "changes affecting security-relevant configuration" are logged with who, when, what, why, and what was the outcome. A tool that applies vulnerability fixes without producing that record makes its operators unable to attest to those controls. The auditor does not accept "we use HexOps, it is secure." They ask "show me the change log for every vulnerability remediation in the last quarter."
- **Incident-response failure.** When a production incident traces back to a recent dependency change, the question is "what did we touch?" If the answer is "I think someone applied a fix to esbuild last Tuesday but I am not sure exactly what changed or whether it worked," that is an incident-response failure on top of the original incident. The investigation reconstructs intent from git logs plus memory plus Slack scrollback. That is slow, error-prone, and traumatic.
- **Accountability failure.** Without a log, "who applied this fix" cannot be answered. In a single-user dev environment, this is academic. In any multi-operator team, accountability requires a trail. Otherwise the question "did we know about this CVE when we deployed?" cannot be answered, which means liability cannot be apportioned, which means lessons cannot be learned and applied to process.

This is why the HexOps logging is the deepest architectural commitment in the security stack. Every other piece of state (the merged findings cache, the exceptions file, the finding-states index) can be regenerated from logs plus scanner re-runs. The log itself cannot be regenerated. It is the irreducible record.

## Every Apply is a change-control event

Before the work this post describes, HexOps logged the successful completion of an Apply (`security_remediation_applied` under the patches log category). That is not nothing, but it is incomplete. Failed Apply attempts left no trace. The intent (what was being attempted, with what parameters) was not logged before the install, only as part of the success record. There was no way to thread "the Apply at 14:32" to "the rescan at 14:34" to "the result the user saw at 14:35."

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

## Why naive logging falls short

There is a tempting middle-ground design: just log the result of each Apply. "Hey, esbuild was bumped to 0.25.12 on May 27 at 14:32." That is a log entry. It is not audit-grade. Four things it hides:

- **It hides intent.** The user clicked Apply intending to resolve 41 CVEs. The bump happened correctly. But the bump did not resolve the CVEs (the Go binary case). A naive log shows "esbuild bumped" and an auditor reading it would think the fix worked. A change-control log shows "intent: resolve 41 CVEs; outcome: 0 resolved; status: unresolved" and they see the truth.
- **It hides failure.** A naive log only fires on success. Failed Apply attempts leave no trace. An attacker who deliberately tries to apply something malicious and gets blocked is invisible. A change-control log fires on both `remediation_initiated` (before anything happens) and `remediation_install_failed` (when it goes wrong), so the trail captures attempts even when they do not succeed.
- **It hides parameters.** A naive log says "esbuild bumped to 0.25.12." A change-control log says "esbuild bumped from 0.25.10 to 0.25.12 via direct install (not override), under audit context source=grype with advisories CVE-2026-39820 plus 40 others, severity=high." You can answer "what versions transitioned" or "did we use an override pin" without rerunning the analysis.
- **It hides correlation.** Naive logging makes it hard to thread "the apply at 14:32" to "the rescan at 14:33" to "the finding that disappeared at 14:34." You are correlating timestamps and hoping nothing else ran in those windows. The `attemptId` makes it one grep.

Naive logging answers "did something happen?" Change-control logging answers "what was the full lifecycle of this specific decision?" Those are different questions, and only the second one is audit-grade.

## Four events, none redundant

Every Apply produces up to four log events. None is duplicative.

```
remediation_initiated  →  remediation_install_complete  →  remediation_completed
                                       OR
                          remediation_install_failed
```

**`remediation_initiated`** fires before the install runs, with the full parameters. This is the intent record. It exists even if the install never executes (network failure, server crash, kill switch flipped). Without it, you cannot detect attempted-but-never-executed Apply operations: operations that timed out, operations the server crashed during, operations where the user clicked Apply but the API never received the request. The initiated event is also the only one that captures the full input; subsequent events reference it by attemptId but do not duplicate the parameters.

**`remediation_install_complete`** or **`remediation_install_failed`** fires when the install pipeline reaches a terminal state. This is the execution record. Distinct from intent because the install might run with different parameters than intended (lockfile reconciliation forces a different version), might fail partway through having mutated some state but not others, or might invoke an install-gate plugin (Safe Chain) that blocks specific packages and requires different downstream interpretation. This event captures what actually happened on the server, distinct from what the user asked for.

**`remediation_completed`** fires after the post-install rescan and verify complete. This is the outcome record. The key insight: an Apply that succeeds at the install layer can still fail at the outcome layer (the hexmetrics esbuild case again). Or partially succeed. The outcome event is the only place that distinguishes these. Without it, the audit log shows "successful install" but cannot answer "did the fix resolve the vulnerabilities?" That is the question an auditor or post-mortem investigator most cares about.

## What attemptId threading lets you query

Because every event for an Apply attempt shares the same `attemptId`, the log becomes queryable as a graph, not just a stream. Concrete operations the threading enables:

- **"Show me every Apply attempt on this project last week."** Grep `remediation_initiated` filtered by date, then for each match grep the same attemptId across the rest of the log to assemble the lifecycle.
- **"Show me every Apply attempt that failed."** Grep `remediation_initiated` for the intent set, grep `remediation_install_failed` for the failure set, the difference is "in-flight, abandoned, orphaned." Itself an interesting signal.
- **"Show me every fix attempt that did not actually resolve findings."** Grep `remediation_completed.*"status":"unresolved"`. Directly answers "what fixes did we try that did not work?" Useful for engineering debrief (why?) and accountability (we tried, we documented, we filed exceptions).
- **"Reconstruct the security state of this project at any point in time."** Replay `finding_detected` plus `finding_resolved` events up to a given timestamp. Lets you answer "what did we know about, when?" The central question of every post-mortem.
- **"What is the time-to-remediate for critical findings on this project?"** Pair `finding_detected` events with their eventual `remediation_completed` events (matched by `findingsCovered` containing the dedupKey). Compute deltas. That is a real MTTR metric, derivable from the log, with no separate metrics infrastructure required.

None of these are possible if the log entries do not share an ID. All of them are trivially possible because they do.

## Finding lifecycle and the silent-disappearance problem

Independent of Apply attempts, every scan emits `finding_detected`, `finding_redetected`, or `finding_resolved` events when the diff against the previous scan reveals new, returned, or vanished findings. Each event carries the dedupKey, severity, package, sources, and advisory IDs. The "first seen N days ago" chip on each finding row in the UI is derived from this index. Findings detected in the last twenty-four hours get a `new` chip.

The problem this solves: **findings can vanish for reasons other than "we fixed them."** Concretely:

- A scanner could stop detecting a CVE because its advisory data lags upstream
- A scanner could fail silently (timeout, network glitch, cache corruption) and return fewer findings
- A package could be removed entirely from the project: the vulnerability is gone but no fix was applied
- A new version of a scanner could change its detection logic: same code, different finding set
- A [grype](https://github.com/anchore/grype) DB refresh could move CVEs around

Without diff logging, all of these look identical to "successful remediation." A finding that was there yesterday is gone today, the dashboard shows zero, everyone celebrates, and three months later someone discovers that the vulnerable code is still in production. The scanner just stopped catching it.

`finding_resolved` events let you correlate vanished findings with explicit remediation attempts. If a `finding_resolved` event fires within minutes of a `remediation_completed` event for the same dedupKey, you have high confidence the fix worked. If a `finding_resolved` event fires with no recent `remediation_completed` correlating to it, that is worth investigating. The finding silently disappeared.

`finding_redetected` is the regression-alert pathway. A finding we thought was resolved is back. Why? Did the fix get reverted? Did the scanner change? Is the dep tree different on a different machine? The event itself does not answer; it raises the question that needs answering, in the same audit log that already contains the original detection and the original resolution.

## The audit-log-as-source-of-truth principle

The deepest design principle behind all of this is: **the log file is the source of truth for what has happened in the system, period.** Not the database. Not the in-memory state. Not the cache. The log.

Every other piece of state in the security stack can be regenerated from logs plus scanner re-runs. The log is the irreducible record. This shapes design decisions in concrete ways:

- Caches can be aggressively invalidated because re-deriving them from scans is the path. The log persists across invalidations.
- Crashes and partial states do not lose audit information because the log is append-only and survives every other state's corruption.
- Migration of derived state (such as exception schema changes) does not require log migration. The log is the contract.

Practical consequence: never put information in the cache or in-memory state that does not also flow through the log. If it is not logged, it did not happen. For a security tool, that is an absolute statement.

The cost of this discipline is rounding-error compared to the value. Each Apply generates 3 to 4 log entries at ~1KB each. A team applying 50 fixes per week generates ~10MB per year. Performance overhead is fire-and-forget through the existing `logger.info` machinery, no new IO patterns. Cognitive load on operators is zero (the logging is invisible until you want it). Compared to losing the ability to attest to compliance, respond to incidents, or apportion accountability, the trade is not close.

This pattern is table stakes for established tools. [Snyk](https://snyk.io), [Dependabot](https://github.com/dependabot), GitHub Advanced Security, [Aikido](https://www.aikido.dev), [Mend](https://www.mend.io) all log every action against a tracked finding ID. The HexOps implementation deliberately patterns after how those tools log. What we are doing is bringing that pattern to a self-hosted, local-first dev tool that did not have it. HexOps users get the same auditability that enterprises get from Snyk, without sending their dependency data to a vendor.

## What this changes

The hexmetrics esbuild case is the bait: an Apply succeeds at the install layer and fails at the outcome layer. Without change-control logging, that fails silently. With it, the audit log holds the truth even when the dashboard might show otherwise.

The full picture of what the operator sees on the screen and what the system records on disk:

- Click Apply. The package bumps. The install succeeds. `remediation_install_complete` lands.
- The post-install rescan runs. The merged findings cache is re-pulled. The targeted dedupKeys are still there. `remediation_completed` lands with `outcome.status: unresolved`.
- The dialog stays open and reports the truth: "the upstream maintainer may not have shipped a release that resolves this advisory." Shortcut to File Exception, with the tracking ID in plain text.
- An auditor three months later greps the security log for `remediation_completed.*projectId=hexmetrics.*"status":"unresolved"` and sees the attempt, the parameters, the outcome, and the timestamp. They do not have to ask the operator. The log holds the answer.

That is the architecture. The hexmetrics case is the visible artifact of it. The Apply succeeded. The CVEs persisted. The log knew.

---

HexOps is open source. Source at [github.com/Hexaxia-Labs/hexops](https://github.com/Hexaxia-Labs/hexops). MIT license. The companion writeup on the multi-scanner architecture that surfaces cases like hexmetrics in the first place is at [The Lockfile Scanner Said Clean. Grype Said Forty-One. Both Were Right.](/blog/hexops-multi-layer-security-scanning/).

Aaron Lamb
Co-Founder, [Hexaxia Technologies](https://www.hexaxia.tech/)
