# Public 0.17.42 Mac notarization diagnostic

This temporary branch reads the four already published packages from release source
`316f6cfbfc061017cc3ac9d847a76db96b71b677`, paired release run `36983817342`.
The diagnostic checkout/run identities are recorded separately. It neither builds nor
launches APEX, changes updater feeds, uses publishing credentials, or installs anything.

`manifest.json` freezes the original public whole-body sizes, SHA256, and SHA512.
All four downloads must match before extraction or ticket assessment. The collector
uses the unchanged source-bound architecture checker and the exact original App
codesign, Gatekeeper, and `xcrun stapler validate` commands. Every command preserves
stdout, stderr, exit status and argv. Mounted DMGs are readonly and detached in finally.
Child HOME/TMPDIR paths are private to the runner output directory.

`original-macos-static-reader.py` is an unchanged audit exhibit, never executed here.
Its absolute workstation paths are unsuitable for the independent runner. This portable
collector covers package bytes, source/version identity, architecture, signatures,
Gatekeeper and tickets; the separately frozen public static/style/native proof covers
the other acceptance checks. A successful remote diagnostic supplements that evidence;
it does not rewrite the three preserved local TLS failures or claim they passed.

The DMG container's original optional signature/ticket commands are recorded separately.
Every App ticket validation must actually exit zero for `all_four_passed` to be true.
