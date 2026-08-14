# APEX Desktop runtime integrity and repair contract

Ticket: hc-727

## Product behavior

- A runtime is usable only when its source entrypoint exists and its own Python
  can import `yaml`, `dotenv`, and `hermes_cli.config`.
- A bootstrap marker, `python.exe`, `hermes.exe`, package metadata, or a clean
  `uv sync --check` result cannot independently attest runtime health.
- Startup must not adopt or fall back to an on-disk runtime that fails the
  launch-dependency probe.
- Windows recovery may use the in-place update path only for a runtime that
  passes the probe. An incomplete runtime takes the repair path and reinstalls
  dependencies from locked, hash-verified artifacts.
- Source installers may fast-skip unchanged dependencies only after the same
  import probe succeeds. A metadata-clean but import-broken environment forces
  a locked reinstall and publishes no success marker until the probe passes.
- Runtime bundle publication smoke must execute the same config dependency
  boundary before and after relocation. A bundle missing PyYAML is not
  publishable.

## Exit inventory

1. Runtime bundle build/publish: locked sync plus archive smoke after extract
   and after relocation.
2. Source install: `install.sh` and `install.ps1` dependency stages.
3. Update: dependency fingerprint and `uv --check` fast paths, followed by the
   locked sync path when integrity fails.
4. Repair: Desktop on-disk adoption and failure fallback, then Windows updater
   selection and the source dependency rebuild.

## Failure states

- Missing PyYAML or another launch dependency fails the runtime probe even if
  the interpreter and dist-info remain on disk.
- A failing probe prevents pre-bootstrap adoption and post-bootstrap fallback.
- A failing probe selects repair on packaged Windows; it must not loop through
  the gentle updater against the same incomplete venv.
- A failed locked reinstall remains an install failure. The client must not
  write/retain an attestation that turns the next launch into a false success.

## Smoke commands

```bash
cd apps/desktop
npx vitest run --project electron electron/backend-probes.test.ts electron/apex-runtime-select.test.ts electron/windows-hermes-path.test.ts
cd ../..
./scripts/run_tests.sh tests/test_install_sh_fast_update_channel.py -q
bash -n scripts/install.sh
node --check scripts/build-runtime-bundle.mjs
```

The bundle smoke command requires a built platform archive and is executed by
the runtime-bundle release workflow. The local unit smoke proves selection and
fast-path behavior; it does not substitute for Windows signed-package repair.
