# APEX media tools COS mirror (hc-906)

This mirror is separate from Desktop releases and engine selection. Updating it
does not modify a customer's project lockfile, installed tools, Desktop updater
feed, or default engine. APEX Desktop 0.17.55 does not contain these binaries.

## Sources and verification

`scripts/media-tools/source-lock.json` pins upstream inputs. FFmpeg 9.0.2's
official archive was verified against its detached OpenPGP signature and release
key fingerprint `FCF986EA15E6E293A5644F10B4322F04D67658D8` on 2026-10-08. Its SHA-256
is checked independently on every build. x264's source commit and zlib's release
archive are also hash pinned. Review upstream signatures/checksums before changing
these entries; never replace a failed checksum with the hash of an unverified download.

`.github/workflows/media-tools.yml` produces two native Mac builds and a Windows
cross build, then executes Windows binaries on a native Windows runner. All three
must encode one second of H.264/AAC, report exact streams/duration with ffprobe,
and extract a valid PNG. The CLI profile contains FFmpeg core, libx264 and zlib;
it does not contain external libass, libx265 or libvpx. No `--enable-nonfree` build
may be published. Intel's portable C build trades optimized assembly for simpler
build prerequisites. Mac minimum deployment target is 12.0.

Every FFmpeg ZIP contains both executables, the exact corresponding sources,
licenses, configuration and build recipe, commit identity, and native test proof.
These are standalone GPL CLI executables, not libraries linked into APEX. To
rebuild, install Python 3.12, make, a compiler and pkg-config, then set
`GITHUB_SHA` to the packaged `BUILD_COMMIT` and run `bash build.sh <target> <empty-dir>`.
Windows cross builds additionally need MinGW-w64 and NASM on Linux.

## Hypit

The owner confirmed that written Hypit.AI commercial redistribution authorization
has been obtained in this task on 2026-10-08. Preserve the original npm archive,
modified Apache license, copyright and brand identifiers. Do not treat this as
permission to change the license or as evidence about unrelated products.

Hypit 0.2.17 requires Node >=22.15.0. Its official npm SHA-512 integrity, package
identity, preserved license, installation and `hypit version` are checked on all
three native targets. The mirror includes the **Hypit npm package**, not a complete
offline npm registry. Transitive npm dependencies still require network access.
Browser installation, project initialization, provider authorization and actual
video rendering are not established by a successful CLI version check.

## Publishing and recovery

1. Complete one successful `Media tools verified builds` run for the pinned inputs.
2. Download its six `media-*-verified` and `hypit-*-verified` artifacts into one
   directory, keeping those artifact names as subdirectories. Do not use the
   unverified Windows candidate artifact.
3. On the publisher, load COS credentials through the existing server environment
   and run Python 3.12 `scripts/media-tools/publish.py <artifact-directory>`.
4. The publisher validates every local artifact before any remote write, builds
   source-inclusive ZIPs, uploads immutable objects below `media-tools/`, and
   hashes the entire public HTTP response for each object. Only then does it write
   and fully read back `media-tools/stable.json`. It never changes `desktop/` or
   the legacy `runtime/ffmpeg-*.zip` objects.
5. A transfer/verification failure leaves the previous stable manifest in place.
   Retrying reuses matching immutable objects. A mismatch under an immutable key
   stops publication. If manifest readback itself fails, inspect COS before
   declaring success; already uploaded packages remain recoverable.

The every-three-days schedule is the Codex thread heartbeat automation `cos`,
not a production systemd daemon. It checks current stable upstream versions,
reviews license changes, rebuilds and tests changed inputs, and publishes only
verified packages. A new upstream release does not mean it is immediately safe
to promote. Leave the last verified mirror available when a platform fails.

Behavioral publisher regression tests:

```sh
scripts/run_tests.sh tests/scripts/test_media_tools_mirror.py -q
```

They reject missing binaries on every target, changes after smoke, mismatched
sources, nonfree configuration, mixed build identities, corrupt Hypit packages,
and failed COS readback. Removing the post-smoke binary hash comparison causes
the tamper regression to fail. These tests do not replace native media tests,
Mac notarization, customer-machine testing, or Hypit render/provider validation.
