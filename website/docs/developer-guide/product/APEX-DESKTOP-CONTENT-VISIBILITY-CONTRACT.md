# APEX Desktop content visibility contract

Ticket: hc-836

## Product behavior

- A long conversation keeps its own reading position across warm session
  switches. Hidden keep-alive panes cannot publish scroll state into the
  visible conversation, and the jump-to-latest action targets only its session.
- New installations and users without an explicit preference start with
  reasoning disclosures collapsed. A later user choice remains durable.
- Workflow Deliverables accept the production schema identifier
  `deliverable/v1`; list and detail responses remain typed and tenant-safe.
- Local audio/video uses the Desktop media protocol with HTTP byte-range
  responses, so long videos can load metadata and seek without buffering the
  entire file as a data URL.
- Media extraction preserves Markdown boundary whitespace. Generated images,
  embedded images, preview markers, and `MEDIA:` tags may remove only their own
  spans, not surrounding prose or fenced content.
- Remote artifact downloads preserve file URIs and relative paths until the
  gateway resolves them against the profile and session that produced them.

## Exit inventory

1. Visible chat pane: scroll publication, restore, history paging, and
   jump-to-latest.
2. Hidden chat pane: keep-alive layout without visible-pane state ownership.
3. Reasoning: first-run default plus persisted explicit choice.
4. Deliverables: run overview, list, and detail projections.
5. Local media: full response, single range, open-ended range, unsatisfiable
   range, `HEAD`, and missing file.
6. Remote artifacts: absolute, relative, tilde, Windows drive, UNC, and
   `file://` paths across profiles.
7. Text/media ingestion: generated-image echoes, embedded data images,
   reference lines, preview targets, and `MEDIA:` tags.

## Smoke commands

```bash
cd apps/desktop
npm run typecheck
npm run lint
npm run test:ui
npm run test:desktop:platforms
npm run test:release-gates
npm run build

cd ../..
HERMES_PYTHON=/path/to/python-with-pytest scripts/run_tests.sh tests/hermes_cli/test_web_server_files.py
```

The local package smoke is `npm run test:desktop:all`. It verifies the current
host package only. It cannot certify the Windows package, both macOS
architectures, Apple notarization, or public updater feeds; the paired Desktop
release workflow owns those production checks.

## Failure injection

- Parse `schemaVersion` as an integer again: both Deliverable projection tests
  fail on `deliverable/v1`.
- Restore the absent-preference fallback to expanded: the reasoning default
  test fails.
- Ignore the stored per-session offset: both session-scroll restoration tests
  fail.
- Ignore a non-empty `Range` header: the protocol integration test and five
  range-response tests fail.
- Trim the final preprocessed Markdown document: the boundary-whitespace test
  fails.

These injections prove the automated guards reach the repaired behavior. They
do not replace a fresh-profile packaged-app walkthrough with a genuinely long
conversation and real generated image/video outputs.
