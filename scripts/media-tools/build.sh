#!/usr/bin/env bash
# Standalone redistributable CLI tools; never publishes a Desktop updater feed.
set -euo pipefail
target="${1:?mac-arm64, mac-x64 or win-x64}"
work="${2:?absolute empty work directory}"
script_dir="$(cd "$(dirname "$0")" && pwd)"
case "$target:$(uname -s):$(uname -m)" in
  mac-arm64:Darwin:arm64|mac-x64:Darwin:x86_64|win-x64:Linux:x86_64) ;;
  *) echo 'Build host does not match target' >&2; exit 1 ;;
esac
mkdir -p "$work"
test -z "$(ls -A "$work")" || { echo 'Work directory must be empty' >&2; exit 1; }
work="$(cd "$work" && pwd)"
python3 "$script_dir/mirror.py" sources "$work"
mkdir "$work/prefix" "$work/ffmpeg-build" "$work/x264-build" "$work/package"
prefix="$work/prefix"
export PKG_CONFIG_LIBDIR="$prefix/lib/pkgconfig"
export PKG_CONFIG_PATH=""
common=(--disable-autodetect --disable-doc --disable-debug --disable-ffplay --enable-static --disable-shared --enable-gpl --enable-libx264 --enable-zlib --extra-cflags="-I$prefix/include" --pkg-config=pkg-config --pkg-config-flags=--static)
if [[ "$target" = win-x64 ]]; then
  export CC=x86_64-w64-mingw32-gcc
  x264_flags=(--host=x86_64-w64-mingw32 --cross-prefix=x86_64-w64-mingw32-)
  ffmpeg_flags=(--target-os=mingw32 --arch=x86_64 --cross-prefix=x86_64-w64-mingw32- --enable-cross-compile --extra-ldflags="-L$prefix/lib -static" --enable-schannel)
  cd "$work/zlib"
  make -f win32/Makefile.gcc PREFIX=x86_64-w64-mingw32- -j4 libz.a > "$work/zlib-build.log" 2>&1
  mkdir -p "$prefix/lib" "$prefix/include"
  cp libz.a "$prefix/lib/"
  cp zlib.h zconf.h "$prefix/include/"
else
  export MACOSX_DEPLOYMENT_TARGET=12.0
  x264_flags=(--host="$(uname -m)-apple-darwin")
  ffmpeg_flags=(--enable-videotoolbox --enable-audiotoolbox --enable-securetransport --extra-ldflags="-L$prefix/lib")
  cd "$work/zlib"
  ./configure --static --prefix="$prefix" > "$work/zlib-configure.log" 2>&1
  make -j4 > "$work/zlib-build.log" 2>&1
  make install >> "$work/zlib-build.log" 2>&1
  # Hosted Intel machines have no guaranteed NASM; portable C code is correct.
  if [[ "$target" = mac-x64 ]]; then
    x264_flags+=(--disable-asm)
    ffmpeg_flags+=(--disable-x86asm)
  fi
fi
cd "$work/x264-build"
../x264/configure --prefix="$prefix" --enable-static --disable-cli --disable-opencl "${x264_flags[@]}" > "$work/x264-configure.log" 2>&1
make -j4 > "$work/x264-build.log" 2>&1
make install >> "$work/x264-build.log" 2>&1
cd "$work/ffmpeg-build"
../ffmpeg/configure --prefix="$prefix" "${common[@]}" "${ffmpeg_flags[@]}" > "$work/ffmpeg-configure.log" 2>&1
suffix=""
[[ "$target" != win-x64 ]] || suffix=.exe
make -j4 "ffmpeg$suffix" "ffprobe$suffix" > "$work/ffmpeg-build.log" 2>&1
cp "ffmpeg$suffix" "ffprobe$suffix" "$work/package/"
cp "$work/ffmpeg/COPYING.GPLv2" "$work/package/LICENSE-FFmpeg.txt"
cp "$work/x264/COPYING" "$work/package/LICENSE-x264.txt"
cp "$work/zlib/zlib.h" "$work/package/LICENSE-zlib.txt"
cp "$work/ffmpeg-build/config.h" "$work/package/ffmpeg-config.h"
cp "$work/ffmpeg-configure.log" "$work/package/"
cp "$script_dir/source-lock.json" "$script_dir/build.sh" "$script_dir/mirror.py" "$work/package/"
cp "$work/ffmpeg.source.tar.xz" "$work/x264.source.tar.gz" "$work/zlib.source.tar.gz" "$work/package/"
printf '%s\n' "$target" > "$work/package/TARGET"
printf '%s\n' "${GITHUB_SHA:-$(git -C "$script_dir" rev-parse HEAD)}" > "$work/package/BUILD_COMMIT"
echo "Built $target: $work/package"
