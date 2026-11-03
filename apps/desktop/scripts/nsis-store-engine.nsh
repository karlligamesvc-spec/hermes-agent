; hc-1058: store the engine archive in the installer byte for byte.
;
; electron-builder adds the nsis.preCompressedFileExtensions files (the engine's
; runtime-bundle-*.tar.gz) right after `SetCompress "${COMPRESS}"`, with
; COMPRESS=auto from the command line (templates/nsis/include/extractAppPackage.nsh).
; Under auto, NSIS's zlib still squeezes a few KB out of gzip data and then
; stores the file compressed, so electron-updater's block diff of the installer
; sees a new byte stream every release. Turning compression off there stores the
; archive verbatim; the app's own 7z is added under `SetCompress off` anyway, so
; only those files and the small uninstaller are affected.
; scripts/assert-update-engine-stored.mjs `nsis` proves the result on every build.
!ifdef COMPRESS
  !undef COMPRESS
  !define COMPRESS off
!endif
