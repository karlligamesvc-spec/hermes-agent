# APEX platform media download recovery contract

This contract covers Desktop/runtime downloads of signed social-media URLs returned by the
ApexNodes tools gateway. The gateway resolves metadata and signed URLs; the runtime fetches bytes
locally before upload to ASR.

## Covered exits

- `social_download` with a share URL.
- `media_transcribe` with a share URL.
- The shared byte downloader is also used by image and generated-video retrieval; those consumers
  retain their single-URL behavior and file-type detection, but inherit atomic writes and bounded
  same-URL recovery.
- Cloud legacy media downloads and Cloud batch downloads are outside this runtime contract. Their
  equivalent recovery remains owned by hermes-cloud.

## Resolution and download order

For each of the two social-media exits, the runtime must:

1. resolve the share URL once;
2. try `download_url`, followed by each distinct `fallback_urls` entry in server order;
3. pass the same `download_headers` to every candidate;
4. after all candidates fail, resolve the original share URL at most once more and repeat the
   candidate sequence;
5. stop with an explicit download error after the refreshed candidates fail.

The runtime must never loop on resolution or ask the user to repeat attempts indefinitely.

## Byte integrity and recovery

- Bytes are written only to a same-directory `.part` file. A completed file becomes visible through
  atomic rename.
- A premature EOF with a declared `Content-Length` is not success.
- A retry with partial bytes sends `Range: bytes=<current-size>-`.
- A `206` response is appended only when `Content-Range` starts at exactly the requested byte, its
  bounds are valid, and its declared segment length and total are consistent.
- A partial `206` received without a Range request is rejected rather than published as a complete
  file.
- If a server ignores Range and returns `200`, the partial file is overwritten from byte zero. The
  response is never blindly appended.
- All attempts are bounded. Every failed terminal path removes the partial file; ASR never receives
  a truncated local artifact.

## User-facing failures

- A CDN `403` does not prove that the original share URL has expired. The runtime immediately
  advances to the next candidate rather than repeating the same rejected signature.
- A `503` from `/social/{platform}/download` is a link-resolution/download outage, not an ASR outage.
- A `503` from `/asr/*` is a transcription outage.
- These messages do not expose provider names, raw server details, signed URLs, user identifiers, or
  credentials. Users may retry later or upload a local media file.

## Smoke and failure-state boundary

Run:

```bash
scripts/run_tests.sh tests/plugins/test_apexnodes_media_download_recovery.py \
  tests/plugins/test_apexnodes_gateway_tools.py -q
```

The recovery suite uses a local HTTP server to produce a real premature EOF, valid Range resume,
Range ignored with `200`, invalid `Content-Range`, main/fallback failure, and one refreshed URL. It
also verifies unrequested partial responses, partial-file cleanup, and route-specific `503`
wording. It does not contact a real social platform, exercise a production proxy/CDN, or validate
the cloud ASR provider itself; those belong to post-deploy synthetic acceptance with non-user
fixtures.


## 2026-10-05 incident verification

The reported share resolved successfully. A fresh response contained 57 distinct media candidates:
the first five returned 403 from Douyin CDN hosts, while candidate index 5 returned valid MP4 bytes.
A browser User-Agent on the primary URL did not remove the 403. The recovered file was 39,465,006
bytes, 160.426984 seconds, H.264 video with AAC audio. Full ffmpeg decode completed with exit 0.
The upstream rejection mechanism (signature policy, regional routing or CDN access restriction)
was not established; it must not be described as a confirmed expired share.

Runtime remediation integrates the previously unmerged hc-735 recovery into the current hc-906
candidate and adds both-tool regression coverage for a 403 primary followed by a valid fallback.
This receipt proves actual video recovery on the local Mac, not the remote customer's installed
runtime, cloud ASR execution or a public Desktop release. No signed URLs, credentials or raw
provider responses belong in the permanent evidence.
