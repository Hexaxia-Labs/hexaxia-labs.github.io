---
title: '389DS SRG Baseline: A Machine-Consumable Hardening Catalog for 389 Directory Server'
description: '43 NIST 800-53 and DISA SRG-mapped controls for 389 Directory Server. Machine-consumable, schema-first, and applicable to RHDS and Red Hat IDM. Alpha, honest about it.'
pubDate: '2026-05-25'
author: 'Aaron Lamb, Hexaxia Labs'
---

389 Directory Server is one of the most widely deployed LDAP implementations in Linux environments. It underpins identity infrastructure across Red Hat, CentOS, Rocky Linux, and Fedora deployments. If you run Linux at any scale, there is a reasonable chance directory services are somewhere in your stack.

The hardening guidance for it is scattered. The DISA STIG for 389DS was withdrawn. The official documentation covers configuration but not security posture. If you want to harden a production 389DS instance against NIST 800-53 or DISA SRG requirements today, you are assembling that picture from multiple sources and hoping nothing falls through.

I started working on this problem about two years ago. At the time, I expected someone else would publish something before I got far enough to make it worth releasing. Nobody did. The gap that existed then still exists now, so I pulled the project out of storage, rebuilt it properly, and decided to push it forward.

[389DS SRG Baseline](https://labs.hexaxia.tech/389ds-srg-baseline/) is the result.

## What It Is

43 security controls for 389 Directory Server, organized across 9 domains: network security, logging and monitoring, configuration management, system hardening, identity and access management, data protection, incident response, backup and recovery, and access control.

Each control is a single markdown file. The file has two parts: a structured YAML frontmatter block and a human-readable rationale section. The frontmatter is the source of truth. It contains the control ID and title, severity rating, control type, framework mappings to NIST 800-53 and DISA SRG, a concrete check command, and a fix command that remediates the finding.

A sample check looks like this:

```yaml
check:
  summary: "Confirm security (TLS) is enabled and the minimum protocol is TLS 1.2."
  command: |
    dsconf <instance> security get | grep -Ei 'security|tls-protocol-min'
  expected: "Security is enabled and the minimum TLS protocol is TLS1.2 or higher."
fix:
  summary: "Enable security and set the minimum TLS protocol version to 1.2."
  command: |
    dsconf <instance> security set --tls-protocol-min=TLS1.2
    dsconf <instance> security enable
    dsctl <instance> restart
```

The documentation site renders from this frontmatter automatically. Future phases will generate Bash audit scripts, Ansible roles, and OpenSCAP XCCDF content from the same source without re-authoring anything.

## RHDS and Red Hat Identity Management

If you run Red Hat Directory Server or Red Hat Identity Management, this baseline applies to you too.

RHDS is the enterprise distribution of 389DS. The same codebase, the same `dsconf` tooling, the same configuration surface. The controls in this baseline map directly. Red Hat IDM goes a layer further, wrapping 389DS with FreeIPA, Kerberos, and Dogtag certificate services, but the directory server at its core is still 389DS and the hardening requirements for that layer are the same. If you are running IDM in a NIST 800-53 or SRG-adjacent environment, this baseline covers the directory component of that stack.

## What It Is Not

This is not a certified STIG. It is not an official DISA SRG. The commands were written from 389DS and Red Hat documentation and the `dsconf` source, but they have not been validated against a live 389 Directory Server. No control has had an independent review. Every control carries an `authored` status, not `reviewed`.

We are being explicit about this because the alternative is shipping something that looks authoritative before it has earned that. Run every command in a non-production environment first. Confirm attribute names against your specific 389DS version. The alpha warning on the site is not boilerplate.

## Testing and Getting Involved

Validation testing begins shortly. The path to a 1.0 runs through testing every command against a live server and getting each control independently reviewed. Neither of those is a one-person job.

If you run 389DS, RHDS, or Red Hat IDM in production, that experience is exactly what this project needs. Validating a control means running the check command against a real instance, confirming the expected output matches what you see, and reporting back. If you find a command that is wrong, a severity rating that does not match your environment, or a control that is missing entirely, that is a contribution worth making.

Issues and pull requests are open at [github.com/Hexaxia-Labs/389ds-srg-baseline](https://github.com/Hexaxia-Labs/389ds-srg-baseline). The control schema and contribution guide are in the repo. If you want to get involved before you are ready to open a PR, open an issue and start a conversation.

## Roadmap

The structure is built around a single source of truth by design. Everything that follows generates from the same control files:

- **Phase 2:** Bash audit script (checks) and Ansible role (remediation) derived from the frontmatter
- **Phase 3:** OpenSCAP XCCDF and OVAL content, scannable with `oscap`
- **Phase 4:** Contribution to [ComplianceAsCode/content](https://github.com/ComplianceAsCode/content), blocked on a license decision (GPL-3.0 today, ComplianceAsCode is BSD-3-Clause)

## Get It

Docs: [labs.hexaxia.tech/389ds-srg-baseline](https://labs.hexaxia.tech/389ds-srg-baseline/)

Source: [github.com/Hexaxia-Labs/389ds-srg-baseline](https://github.com/Hexaxia-Labs/389ds-srg-baseline)

GPL-3.0. Contributions welcome via GitHub issues and pull requests.
