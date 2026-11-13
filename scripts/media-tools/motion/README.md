# APEX motion toolkit (hc-1221)

The renderer behind the `explainer-video` platform skill: huashu-motion 0.4.0 (MIT) from its npm package, trimmed to
the `om` CLI, the page engine and player, the preview studio, and Noto Sans SC 500/700/900 (OFL). No GSAP, no
「豆子花叔」 character, no command that downloads models or samples. `build_toolkit.py` says exactly what is kept and why.

- Build: `python build_toolkit.py <empty folder>` prints the `motion` entry for `../desktop-lock.json`; `--check`
  fails unless the build equals the lock. Same inputs, same bytes.
- Publish (APEX COS, needs the owner's go-ahead): `python publish_toolkit.py <folder>/motion-toolkit.tgz` with
  `COS_SECRET_ID`/`COS_SECRET_KEY` from the server environment; it uploads only an archive equal to the lock and reads
  it back over HTTPS.
- Use: `"$APEX_PYTHON" -m apex_overlay.media_tools motion <om command> …` installs the pinned toolkit once into
  `HERMES_HOME/tool-cache/motion/<sha256>/` and runs `om` with the engine's Node, the Agent browser's Chromium
  (`OM_CHROME`) and the bundled ffmpeg. Templates live in the platform skill, not here.
