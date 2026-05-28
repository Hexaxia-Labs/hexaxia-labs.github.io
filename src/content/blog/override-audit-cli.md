---
title: 'The First Override Was Redundant. The Second Was Permanent. The Third Was Partial.'
description: 'Three real overrides in one project, three different failure modes that no mainstream tool surfaces. override-audit-cli is an eight-detector hygiene auditor for npm and pnpm override files, with --fix, change-control logging, and no AI surface area in the security path. Open source, local-first, MIT.'
pubDate: '2026-05-28T09:00:00-04:00'
author: 'Aaron Lamb, Hexaxia Labs'
---

I [wrote about postcss recently](/blog/hexops-cve-lite-integration/). The short version: when a framework like Next.js exact-pins a transitive dependency to a known-vulnerable version, you write an override by hand, you forget which overrides are still load-bearing, one bad squash-merge later your override is gone and the CVE is back. The case study landed and the lesson held: prefer floor pins over exact pins, treat your overrides like the supply-chain mutations they are.

In the same project, a different shape of the problem is back. Different dependency this time. Same lockfile.

Open the `package.json` for hexmetrics:

```json
"overrides": {
  "postcss": "8.5.15",
  "@esbuild-kit/core-utils": {
    "esbuild": "^0.25.0"
  },
  "@esbuild/linux-x64": "latest"
}
```

Three overrides, two of them targeting esbuild via different routes, one of them the original postcss case. Each one is doing something, none of them is doing what the operator who wrote them actually believes is happening, and nothing in the standard tooling stack will tell you any of this.

This post walks through each override using the actual hexmetrics lockfile as the witness, names the three categories of override failure they represent, then announces the tool I built to detect those three categories and five more: `override-audit-cli`. Open source, MIT, shipping today at v0.3.0. Source at [github.com/Hexaxia-Labs/override-audit-cli](https://github.com/Hexaxia-Labs/override-audit-cli); `npm` publish coming.

## The dependency, briefly

[esbuild](https://esbuild.github.io) ships as a platform-specific binary package. The npm package you install (`esbuild`) is a thin JS wrapper that delegates to a native binary distributed in a separate per-platform package: `@esbuild/linux-x64`, `@esbuild/darwin-arm64`, and so on. That binary is compiled Go code, complete with an embedded Go standard library version.

esbuild appears in dependency trees through three routes:

- Directly, as your bundler
- Transitively, through tsx, vite, tsup, biome, vinxi, or any of dozens of build tools that wrap it
- Transitively through deprecated wrappers (like `@esbuild-kit/core-utils`) that were absorbed into newer packages but still ship in tree because some other package has not migrated yet

The hexmetrics project hits all three routes. Now look at what the overrides are trying to do.

## Override one: pin a transitive inside a deprecated parent

```json
"@esbuild-kit/core-utils": {
  "esbuild": "^0.25.0"
}
```

This says: wherever `@esbuild-kit/core-utils` appears in the dependency tree, force its declared `esbuild` dependency to satisfy `^0.25.0` instead of whatever it originally requested.

What `@esbuild-kit/core-utils` originally requested:

```
"esbuild": "~0.18.20"
```

So the override is bumping a very old esbuild range to a more recent one inside this transitive wrapper. Reasonable on the face of it. Until you look at the npm metadata for the parent package itself:

```
"node_modules/@esbuild-kit/core-utils": {
  "version": "3.3.2",
  "deprecated": "Merged into tsx: https://tsx.is",
  "dependencies": {
    "esbuild": "~0.18.20",
    "source-map-support": "^0.5.21"
  }
}
```

The parent package is **explicitly deprecated**. The npm registry deprecation notice literally tells you where it went: it was merged into [tsx](https://tsx.is). It will never get another release. There will be no upstream version of `@esbuild-kit/core-utils` that updates its esbuild dependency on its own. The override pinning esbuild inside it is permanent until you migrate the dependency that pulls `@esbuild-kit/core-utils` into your tree to begin with.

The override is doing its job. The parent is the problem. Nothing about your override file, your lockfile, or your standard scanner output tells you that the parent is dead and the override will be in your tree forever.

This is **failure mode one: the override targets a deprecated dead-end parent.** No path forward without migrating off the parent. The override is permanent, and nobody is going to surface that fact to you.

## Override two: pin the platform binary to latest, hope for unification

```json
"@esbuild/linux-x64": "latest"
```

This says: wherever `@esbuild/linux-x64` is requested, install the latest version, regardless of what range the requesting package specified.

The intent is to drag the embedded Go binary forward, presumably because [grype](https://github.com/anchore/grype) is reporting CVEs against the Go stdlib version that ships inside an older `@esbuild/linux-x64`. Get the latest, get the newest Go, problem solved.

What the lockfile shows:

```
"@esbuild/linux-x64": "0.25.12"
"@esbuild/linux-x64": "0.28.0"
```

Two versions of `@esbuild/linux-x64` present in the same tree. The override resolved to 0.28.0 (the latest at install time) along the path it controlled, but a different path through the tree pulled in 0.25.12 anyway and the override did not collapse them. Both binary directories are present on disk. The CVEs grype reported against the Go binary inside 0.25.12 are still there, in the same project the operator just "fixed."

This is the [Apply that succeeded but did not fix](/blog/hexops-change-control-logging/) pattern, captured at the lockfile layer instead of the scanner-and-Apply layer. The override was honored. The install succeeded. The tree still contains the vulnerable copy.

A note on how this problem became visible. The npm package `@esbuild/linux-x64@0.25.12` is not flagged by any npm-side advisory. `npm audit`, `pnpm audit`, CVE Lite, all clean against this package. The vulnerability does not live in the package metadata; it lives inside the package payload. The Go binary that ships in the platform-specific tarball is compiled against an older Go standard library version that carries CVEs. That is a filesystem-layer problem, not an advisory-layer one.

[grype](https://github.com/anchore/grype) reads the filesystem. It finds the binary, identifies the embedded Go version, looks up CVEs against that Go version. That is what surfaced the forty-one findings against this exact case in the first place. Without a filesystem-layer scanner in the stack alongside the lockfile-layer scanners, the multi-version twin persists silently and the dashboard shows clean. That story is its own writeup: [The Lockfile Scanner Said Clean. Grype Said Forty-One. Both Were Right.](/blog/hexops-multi-layer-security-scanning/)

This is **failure mode two: the override resolves correctly but does not unify multi-version installs.** Two versions of the same package ending up in the same tree is a feature of npm's flat-then-nested resolution algorithm, not a bug. An override on one path does nothing about the other path. Nothing in the standard tooling stack tells you that your override is partial. The combination of filesystem scanning surfacing the persistence and override-auditing surfacing the cause is what makes the failure mode addressable at all.

## Override three: the original postcss case, now stale

```json
"postcss": "8.5.15"
```

This is the override from the original writeup. It was needed because Next.js exact-pinned postcss to a version with a known CVE, and `npm audit fix --force` wanted to downgrade Next to fix it. The override forced postcss to 8.5.15 across the tree.

Look at what the lockfile actually shows being requested by various packages now:

```
"postcss": "8.4.31"     ← Next.js' exact pin, the original problem
"postcss": "^8.5.6"
"postcss": "^8.5.10"
"postcss": "^8.5.15"
```

Three of four packages now request open ranges that 8.5.15 satisfies. The override is still doing work: it is still neutralizing Next.js' exact pin to 8.4.31, which would otherwise be the vulnerable resolution. But the other three ranges have moved enough that they would naturally resolve to something in the 8.5.x family without the override at all.

So the override is still **partially** load-bearing. The exact pin to `8.5.15` is now a trap. The moment postcss 8.5.16 ships with a security patch and 8.5.15 becomes the vulnerable version, the override transitions from "fixing a problem" to "creating a problem." A floor pin (`>=8.5.15`) would have prevented this. The original writeup recommended exactly that. The override was not updated.

This is **failure mode three: the override is candidate-redundant or candidate-floor-able.** Upstream ranges have moved. The exact pin is no longer strictly necessary, and the form of the pin (exact vs floor) makes it a future trap. Nothing in your standard tooling tells you "your override might not need to be an exact pin anymore."

## Three failure modes, none of which mainstream tooling detects

Pulling the patterns together:

| Failure mode | Concrete signal in lockfile | Current mainstream tooling response |
|---|---|---|
| Permanent (deprecated parent) | The package npm metadata says `"deprecated": "..."` and your override targets a dependency inside it | Silent. Scanners do not look at the override file. |
| Partial (multi-version in tree) | Same package name appears at two different versions in the lockfile, override resolves only one | Silent. Scanners may flag the older version, but the connection to the override is invisible. |
| Stale (candidate-redundant or wrong-form pin) | Upstream ranges now satisfy without the override, or the override is an exact pin where a floor pin would be safer | Silent. Scanners do not reason about whether an override is still needed. |

The override file is being treated by every dependency tool I know of as opaque config. Your scanners read your lockfile. Your patch tools update direct dependencies. Your update flow regenerates lockfiles. None of these treat the override file as a first-class artifact whose lifecycle needs management.

So overrides are written by hand, accumulate over time, drift out of relevance, target dead-end packages, partially apply, and quietly trap your project on stale versions. Nobody is watching the watcher.

## Three seeds, eight detectors

The three failure modes above seeded the tool. Working through them surfaced a wider set of failure shapes that share the same root cause: the override file is the input, the resolved tree plus disk state is the output, and the gap between intent and outcome is unmonitored.

`override-audit-cli` ships v0.3.0 today with eight detectors covering two phases:

- **Static analysis** of `package.json`: shape of the override, where it lives in the file, what it targets, whether the target exists, whether the pin form is durable
- **Post-install verification** of what is actually on disk: whether vulnerable copies survived, whether multi-version installs went unresolved

The eight rules:

| Rule | Severity | Catches |
|---|---|---|
| `OA001-ORPHAN-TARGET` | low | Override target not in resolved tree |
| `OA002-FLOATING-TAG` | medium | Pin uses `latest` / `next` / `*` / non-semver |
| `OA003-WRONG-SECTION` | high | `pnpm.overrides` in npm project (or vice versa) |
| `OA004-INSTALLED-NEWER` | low | Installed version surpassed concrete pin |
| `OA005-NESTED-OVERRIDE` | info to critical | Nested-object override (five sub-codes) |
| `OA006-COUPLED-PLATFORM-BINARY` | high / medium | Override fights an exact-pinned parent |
| `OA007-FROZEN-LATEST` | high | `"latest"` pin resolved long ago, registry has moved on |
| `OA008-VULNERABLE-TWIN` | critical | Vulnerable copy still on disk despite the override floor |

`OA005` sub-codes: `.a-NON-NPM` (critical), `.b-ORPHANED-OUTER` (high), `.c-ORPHANED-INNER` (high), `.d-LEAKY` (medium), `.e-SUSPECT` (info, off by default).

Mapping the three hexmetrics seed cases to the rules:

- The **multi-version-in-tree** case (override two, the platform binary) fires `OA006-COUPLED-PLATFORM-BINARY` on the override-fights-exact-pinned-parent shape, and `OA008-VULNERABLE-TWIN` on the disk-state check that finds the older copy still present. Both rules report against the same hexmetrics lockfile.
- The **stale exact pin** case (override three, postcss) is partially caught by `OA004-INSTALLED-NEWER` when the installed version has surpassed the pin, and structurally addressed by the floor-pin recommendation `OA006` emits as its fix.
- The **deprecated parent** case (override one, `@esbuild-kit/core-utils`) is the gap. Detecting it requires querying npm registry metadata for the parent and reading the `deprecated` field. That work is on the v2.0 roadmap as `optional registry-driven deprecated-parent detection`. Today the tool surfaces the nested-override shape via `OA005`; v2.0 adds the deprecation reasoning.

So of the three seed cases, two are detected today directly and one is partial with future work explicitly scoped. The five other rules grew out of failure shapes the hexmetrics analysis surfaced along the way: orphan targets, floating tags, wrong-section overrides, nested-form failures, and the "latest" pin that has aged out of currency without anybody noticing.

## How to use it

`npm` publish is imminent. Until then, install from source:

```bash
git clone https://github.com/Hexaxia-Labs/override-audit-cli.git
cd override-audit-cli
npm install && npm run build
npm link
```

That makes the `override-audit` binary available on your `PATH`. Once the package is published, the canonical install will be `npm install -g @hexaxia-labs/override-audit-cli`.

The CLI binary is `override-audit`:

```bash
override-audit                       # audit cwd
override-audit /path/to/project      # audit specific directory
override-audit --json                # JSON output (for CI / orchestrators)
override-audit --severity high       # only high+/critical (CI gate friendly)
override-audit --fix --dry-run       # preview what --fix would change
override-audit --fix                 # apply RFC 6902 patches, rewrite package.json, rescan
```

Exit codes:

| Code | Meaning |
|---|---|
| `0` | Clean: no findings at or above `--severity` |
| `1` | Findings present (above threshold) |
| `2` | Internal error (bad input, unknown flag) |

For most projects the entire first run is one command:

```bash
override-audit
```

Findings come back in a single ranked list, grouped by rule, with the exact override path into your `package.json` and a remediation suggestion per finding. The one detector that needs network access (`OA007-FROZEN-LATEST`) is opt-in via `--with-registry`. Everything else runs offline against the lockfile and disk state.

## Fix, do not just lint

For the rules where a deterministic fix exists, `--fix` applies it. The tool emits RFC 6902 JSON patches, applies them against an in-memory parse of `package.json`, then atomically rewrites the file. The post-fix rescan confirms the new state.

`OA006-COUPLED-PLATFORM-BINARY` is the canonical multi-op fix: remove the override on the platform-binary leaf, add a floor pin on the parent. Two operations, one finding, one patch:

```json
[
  { "op": "remove", "path": "/overrides/postcss" },
  { "op": "add", "path": "/overrides/next", "value": ">=16.2.6" }
]
```

That is the exact patch shape `--fix` emits for the postcss-under-Next case from the original writeup, derived programmatically from the lockfile evidence and the parent declaration. The hand-rolled override pattern that took a year of operator time to learn now writes itself.

## Change-control logging, for the orchestrators

Every `--fix` run can stream NDJSON change-control records to a log file, designed to be consumed by HexOps' (and any other orchestrator's) audit trail. One JSON record per line. Flags:

```bash
override-audit --fix \
  --attempt-id rem_abc-123 \
  --source ci \
  --advisory GHSA-xxxx-yyyy-zzzz \
  --meta repo=myapp --meta runner=gha \
  --log-file /var/log/override-audit.log \
  /path/to/project
```

A run emits, in order: `remediation_attempt` (once, with attempt context) then 0..N of `remediation_applied` / `remediation_failed` / `remediation_skipped` then `remediation_complete` (once, with summary and exit code).

This is the same change-control discipline I [wrote about in HexOps' Apply pipeline](/blog/hexops-change-control-logging/), extended down into the override-fix layer. Detect-only runs and `--fix` runs without `--log-file` emit nothing, so embedders who do not care never see the logger.

## Composes with CVE Lite, does not replace it

The relationship between `override-audit-cli` and CVE Lite is intentional. The two tools operate on different artifacts at different points in the override lifecycle.

### Where CVE Lite covers the override problem

[**CVE Lite**](https://owasp.org/cve-lite-cli) reads your lockfile, identifies vulnerable packages, and tells you exactly how to fix them. For the postcss-under-Next case from the original writeup, CVE Lite did the heavy lifting:

- Identified that postcss in the tree was vulnerable
- Identified that the vulnerability came in through a Next.js exact pin on a transitive
- Told me the right form of fix was a parent-targeted override
- Recommended a floor pin (`>=`) over an exact pin
- Validated the safe version against OSV before suggesting it

That is correct and complete remediation guidance for the moment you need to write the override. If every developer wrote overrides exactly as CVE Lite suggested and never touched them again, the override-file hygiene problem would be much smaller. Failure mode one (the deprecated dead-end parent) would still describe a real edge case. But failure modes two and three would barely exist.

### Where CVE Lite stops

CVE Lite operates on the lockfile, which is the output of dependency resolution. It does not read the override file as a managed artifact. After you write the override, CVE Lite does not come back to validate that:

- The override you wrote actually applies (orphan target)
- The pin form you used matches what was recommended (exact-when-floor-was-suggested)
- The override is in the section the package manager reads (`pnpm.overrides` in an npm project)
- The override produced a unified tree (multi-version twin)
- The vulnerable copy is actually gone from disk after install (vulnerable twin)
- The override is still load-bearing months or years later (candidate-redundant)
- The parent the override targets is itself maintained (deprecated dead-end)

The gap is structural, not an oversight. CVE Lite reads the lockfile to find advisory-to-package matches. That is its contract. Reading the override file as a separate artifact, traversing the parent graph to verify deprecation, walking the on-disk `node_modules` tree to check for surviving copies, these are different reads of different inputs at different points in the override lifecycle.

### Why a separate tool, not a flag on the scanner

The right move is composition, not feature creep. Tools that try to do everything end up doing each thing slightly worse than the focused tool. The scanner (CVE Lite) stays a scanner. The override auditor (`override-audit-cli`) stays an override auditor. Same shared philosophy: local-first, lockfile-aware, no AI surface area in the security path, no cloud round-trip, machine-consumable output. Different detection logic, which is the right answer.

Run both. CVE Lite tells you the postcss CVE exists in your tree and the parent-pin pattern is the right fix. `override-audit-cli` tells you whether the parent-pin you wrote is actually working, whether your platform-binary `"latest"` override is producing the multi-version twin you did not want, and whether your three-year-old override file has accumulated traps.

What `override-audit-cli` does **not** do, by design:

- Does not scan for vulnerabilities. CVE Lite's job at the advisory layer; grype's job at the filesystem layer.
- Does not detect malicious or typosquatted packages. That is a different class of tool entirely.
- Does not manage your install lifecycle. The orchestrator's job (HexOps, your CI, you at the prompt).

What it does, that no other tool I can find does: audits the override declarations themselves as a first-class artifact, not as opaque config the rest of the stack ignores.

## Roadmap

- **v0.3.x**: `--install` / `--no-install`. Reserve install management for the orchestrator that owns it. `--fix` patches `package.json`; the install runs separately when the orchestrator (HexOps, CI, the operator at the prompt) is ready for it. One install per Apply, not two. This is the integration lever that makes the v1.0.0 HexOps embed clean.
- **v1.0.0**: HexOps `OverrideAuditSource` integration. `override-audit-cli` becomes the fourth ScanSource in HexOps alongside cve-lite, grype, and pnpm-audit. Findings stream into the same UI, fixes use the same Apply pipeline, change-control logging threads into the same audit log.
- **v1.1.0**: Yarn `resolutions` support. Optional GitHub Action wrapper.
- **v2.0**: Bun overrides. Optional registry-driven deprecated-parent detection. (This is the missing piece for hexmetrics' override one. Today the tool surfaces the nested-override shape; v2.0 surfaces the deprecation status of the parent.)

## Why this matters beyond hexmetrics

A real Next.js or React or Vite project of any age accumulates overrides the same way hexmetrics did. Every override starts life solving a real problem. Every override ages out of relevance. Most never get cleaned up because nothing tells the operator they should be.

The compounding effect is that **the override file becomes a record of past panics, not a current security control.** Three years in, your `package.json` has eight overrides. Four of them are for packages you no longer depend on. Two of them target dead-end parents. One of them is now a trap because it exact-pinned to what is now the vulnerable version. One is still legitimately load-bearing. The operator cannot tell which is which without doing the analysis by hand on every audit, and nobody does that.

Dependency tools treat the dependency tree as the artifact under management. The tree is part of the artifact, but it is not all of it. **The full artifact is the dependency tree plus its overrides plus its lockfile plus the change history of all of those.** Mainstream tooling only manages the first one. The override file is the most neglected piece because it is the easiest to forget and the most expensive to audit by hand.

That is the gap `override-audit-cli` is built to close. The hexmetrics lockfile was the first specimen. The three failure modes were the seed. Eight rules ship today, the HexOps integration lands in v1.0.0, and the override file finally gets the same first-class treatment the rest of the dependency stack has had for years.

If you have a project that has been collecting overrides for a year or more, point `override-audit` at it and read what comes back. You will probably find at least one finding you did not expect. That is the gap.

---

`override-audit-cli` is open source. Source at [github.com/Hexaxia-Labs/override-audit-cli](https://github.com/Hexaxia-Labs/override-audit-cli). MIT license. 200 tests, eight detectors, Node 18 or newer. `npm` publish coming.

The prior posts in this arc: [The postcss That Would Not Die, and How CVE Lite Ended My Override Grind](/blog/hexops-cve-lite-integration/), [The Lockfile Scanner Said Clean. Grype Said Forty-One. Both Were Right.](/blog/hexops-multi-layer-security-scanning/), and [The Apply Succeeded. The CVEs Persisted. The Log Knew.](/blog/hexops-change-control-logging/).

Aaron Lamb
Co-Founder, [Hexaxia Technologies](https://www.hexaxia.tech/)
