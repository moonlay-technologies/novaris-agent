# YARA rules

`yaraScanCollector.ts` and the `scan_path` response action both scan against every `.yar`/`.yara` file in this directory.

## What's actually here right now

Just `eicar-test-file.yar` - a rule matching the [EICAR standard test string](https://www.eicar.org/download-anti-malware-testfile/), a public-domain string every antivirus/scanner vendor supports specifically so you can verify a scanning pipeline actually works end to end, without needing a real malware sample. It is **not** a real threat signature.

## Why there isn't more yet

Porting the old keyword-matching logic into Sigma rules (see `src/rules/sigma/`) was a low-risk translation of logic that already existed in this codebase. There was no equivalent existing malware-detection logic to port here - authoring genuinely effective YARA signatures (packer detection, known-malware-family patterns, etc.) is specialized security-research content work, not something to fabricate without a proper rule-quality/false-positive review process.

**Populating this directory with real detection content is a deliberate follow-up**, not something silently assumed done by shipping the scanning pipeline. Two reasonable paths:
- Author/curate a small rule set in-house, reviewed by whoever owns detection engineering.
- Adopt an existing open rule repository (e.g. [Yara-Rules/rules](https://github.com/Yara-Rules/rules), [Neo23x0/signature-base](https://github.com/Neo23x0/signature-base)) - check each repository's specific license before bundling, since terms vary rule-set to rule-set (some are permissive, some restrict commercial redistribution).

Any `.yar`/`.yara` file dropped in this directory is picked up automatically - no code changes needed to add more rules.
