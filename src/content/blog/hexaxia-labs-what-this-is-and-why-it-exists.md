---
title: 'Hexaxia Labs: What This Is and Why It Exists'
description: 'Labs is where the open source work from across the Hexaxia Group lives. HexOps, HexCMS Studio, 389DS SRG Baseline, and what comes next.'
pubDate: '2026-05-25T17:17:00-04:00'
author: 'Aaron Lamb, Hexaxia Labs'
---

Hexaxia is a group of companies. [Hexaxia Technologies](https://www.hexaxia.tech) does managed IT, infrastructure, and security consulting. [Hexaxia AI](https://www.hexaxia.ai) runs AI transformation engagements and builds AI infrastructure products. [Hexaxia Media](https://www.hexaxia.media) handles the creative and media side of the group.

Each division does different work. Some of it is client-specific. Some of it is not.

Labs is where the second kind lives.

When a division builds something general enough to be useful outside its own operation, it goes here. Not because we are trying to build a community or grow a following, but because keeping useful tools private when they solve a problem anyone could have is a waste. We work in real infrastructure and real production environments. Things get built. The ones worth sharing, we share.

## HexOps

The first project was [HexOps](https://github.com/Hexaxia-Labs/hexops), a developer operations dashboard that came out of managing too many local projects at once. The specific problem: a CVE drops and you have 15 projects that need patching. The manual path is cd into each one, run the audit, update, commit, repeat, and hope you did not miss one. HexOps handles it from a single interface.

It scans every project for vulnerabilities and outdated packages concurrently, patches them in batch, and runs a post-patch audit to confirm the advisories are actually gone. It handles transitive dependency issues with automatic override detection, flags collateral downgrades across other projects when a patch lands, and gives you an escalation path when a patch cannot land cleanly: force-override, force-major bump, or accept-risk with an expiry date. There is also a code security scanner with 16 grep-based rules covering hardcoded secrets, command injection, weak crypto, and common misconfigurations.

v0.13.0, MIT license.

## HexCMS and HexCMS Studio

[HexCMS](https://github.com/Hexaxia-Labs/hexcms) is a git-based headless CMS currently in development. Content lives in your repository as markdown files with frontmatter. No database, no vendor lock-in, no SaaS subscription.

[HexCMS Studio](https://github.com/alamb-hex/hexcms-studio) is the visual editor that runs alongside it and is already released. It runs locally on your machine with direct filesystem access. You get WYSIWYG editing via TipTap and raw markdown mode, a frontmatter editor, live preview, git integration that lets you stage, commit, push, and pull without leaving the UI, and multi-repository support so you can manage content across several projects from one interface. Multiple themes: light, dark, midnight, and sepia.

HexCMS Studio is v0.2.0, MIT license. HexCMS is AGPL-3.0.

## 389DS SRG Baseline

[389DS SRG Baseline](https://labs.hexaxia.tech/389ds-srg-baseline/) came from Hexaxia Technologies' infrastructure work. 389 Directory Server is widely deployed in Linux environments and there is no good public hardening baseline for it. So we wrote one.

43 controls across 9 domains: network security, logging and monitoring, configuration management, system hardening, identity and access management, data protection, incident response, backup and recovery, and access control. Each control is a markdown file with structured YAML frontmatter containing a check command, a fix command, framework mappings to NIST 800-53 and DISA SRG, and an in-depth rationale. The frontmatter is the single source of truth: the documentation site renders from it today and future phases will generate Bash audit scripts, Ansible roles, and OpenSCAP XCCDF content from the same files without re-authoring.

It is v0.1.0-alpha. The commands have not been validated on a live server and no control has had an independent review. We are saying that plainly because the alternative is shipping something that looks authoritative and is not. GPL-3.0, contributions welcome.

---

More will come from across the group as work produces them. This blog is where we write about what we are building, the decisions behind it, and what did not go as expected. No release theater. Just the work.
