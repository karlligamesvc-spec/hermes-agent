# OpenFilm patches (hc-1175)

APEX opens an agent's `film.html` in OpenFilm Studio (prototype hc-1173). The OpenFilm toolkit APEX uses is the
pinned upstream package (`pin.json`, MIT) with the patches in `patches/` applied when the toolkit is built. Upgrading
means changing the version in `pin.json` and checking each patch still applies and still passes. A patch goes away
once upstream ships the same fix.

## 0001-keep-track-fields

In openfilm 0.3.0, once the person edits anything in Studio, the next time the agent writes `film.html` Studio's
keep-the-person's-edits merge (`studio/server/person-merge.mjs`) drops every caption track
(`<section><track kind="captions" …></section>`). It can also drop a track's `attrs`, a caption track's flags, and a
person's change to them. The cause: kept versions held only each track's clips and its three flags, the merge kept
only tracks that have clips, and tracks were told apart by their clips, which a caption track does not have.

The patch keeps every field a track has, not only its clips. The fields come from `film-doc.mjs`'s `TRACK_FIELDS`
(now exported), so a field added upstream is kept too. Each field is merged three ways, the way flags already were.
A caption track is named by its WebVTT file wherever a clip is named by its id: whether it is there, its fields,
the tracks' order, and the note to the agent. It does not change how clips merge.

## Checking

```
node scripts/media-tools/openfilm/verify.mjs <empty work folder>
```

`verify.mjs` fetches the pinned package (integrity-checked) and the upstream source at the pinned commit, and checks
that the files a patch touches are the same in both. It applies the patches to both, then runs:

- `track-fields.test.mjs`, the guard. Every field of `TRACK_FIELDS` but `clips` goes through "the person edits, the
  agent writes over it", "the agent changes it", "the person changes it", "the merge fails", and more. It needs a
  sample for each field, so a field added upstream fails it until covered. On unpatched 0.3.0, 42 of its 45 tests
  fail.
- `reverse-verify.mjs`. It takes each of the 12 parts of the fix back out of a copy of the patched package, one at
  a time. The exact text must be found once. Each removal must turn the guard red.
- Upstream's own tests of what the patch touches (`pin.json` `upstreamTests`, 131 at 0.3.0), with no browsers.

`.github/workflows/openfilm-patch.yml` runs it on every pull request and `main` push that touches this folder (and on
no other). Locally, behind the CN proxy, set `NODE_USE_ENV_PROXY=1 HTTPS_PROXY=…` for the downloads, and pass git a
proxy through `GIT_CONFIG_COUNT`/`GIT_CONFIG_KEY_0`/`GIT_CONFIG_VALUE_0`.
