#!/bin/bash
# hc-1083：在本机起一份隔离的 APEX 打包产物（全新空环境），给多助手验收用。
#
#   fresh-env-mac.sh prepare <DMG 或 .app> <测试目录>   # 拷出 App，建空的家目录
#   fresh-env-mac.sh launch  <测试目录> [--multi-bot] [--fast-pool]
#   fresh-env-mac.sh python  <测试目录>                  # 引擎自带 python（跑 multi_bot_qa.py 用）
#   fresh-env-mac.sh stop    <测试目录> [--force]        # SIGTERM 主进程，列出残留进程
#   fresh-env-mac.sh cleanup <测试目录> [--delete]       # 从 LaunchServices 注销，--delete 才删目录
#
# 规矩（硬规则 11 + 2026-10 的几次踩坑）：
# - 每次验收用一个新的空目录，不拿以前跑过的家目录自证；
# - 直接起 App 里的二进制，不用 open（open 会按 bundle id 找到 /Applications 里那个）；
# - HERMES_HOME / userData / 工作目录都在测试目录里，--use-mock-keychain 不碰正式版的钥匙串条目；
# - --fast-pool 把池的闲置回收压到 60 秒、保鲜窗口压到 120 秒，只用来快速摸行为，正式数字必须用默认值。
set -euo pipefail

usage() { sed -n '2,8p' "$0"; exit 2; }
[ $# -ge 2 ] || usage
ACTION=$1
LSR=/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister

abs() { (cd "$1" && pwd -P); }

prepare() {
  local src=$1 dir=$2
  mkdir -p "$dir"
  dir=$(abs "$dir")
  if [ -e "$dir/home/hermes" ] && [ -n "$(ls -A "$dir/home/hermes" 2>/dev/null)" ]; then
    echo "拒绝：$dir/home/hermes 已经有东西，全新环境请换一个空目录"; exit 1
  fi
  case "$src" in
    *.dmg)
      mkdir -p "$dir/mnt"
      hdiutil attach -nobrowse -readonly -mountpoint "$dir/mnt" "$src" >/dev/null
      ditto "$(ls -d "$dir"/mnt/*.app | head -1)" "$dir/APEX.app"
      hdiutil detach "$dir/mnt" >/dev/null
      rmdir "$dir/mnt";;
    *.app) ditto "$src" "$dir/APEX.app";;
    *) echo "要 .dmg 或 .app：$src"; exit 2;;
  esac
  mkdir -p "$dir/home/hermes" "$dir/home/userdata" "$dir/home/cwd" "$dir/runs"
  echo "hc-1083 test dir created $(date -u +%FT%TZ) from $src" > "$dir/.hc-1083-test-dir"
  echo "App 版本：$(defaults read "$dir/APEX.app/Contents/Info.plist" CFBundleShortVersionString)"
  codesign --verify --deep --strict "$dir/APEX.app" 2>/dev/null && echo "codesign ok" || echo "注意：codesign 校验没过"
  local rel
  rel=$(find "$dir/APEX.app/Contents/Resources" -path '*bundled-runtime/release.json' | head -1)
  [ -n "$rel" ] && /usr/bin/python3 -I -c 'import json,sys; d=json.load(open(sys.argv[1])); print("自带引擎", d.get("runtime_commit","?")[:12], d.get("runtime_version",""))' "$rel"
  if pgrep -f "/Applications/APEX.app/Contents/MacOS/APEX" >/dev/null; then
    echo "注意：/Applications/APEX.app 正在运行。两个窗口都叫 APEX、bundle id 相同，computer use 分不清，验收前先退出它。"
  fi
  echo "准备好：$dir"
}

launch() {
  local dir multi="" fast=""
  dir=$(abs "$1"); shift
  [ -f "$dir/.hc-1083-test-dir" ] || { echo "不是 prepare 建的测试目录：$dir"; exit 1; }
  for flag in "$@"; do
    case "$flag" in
      --multi-bot) multi=1;;
      --fast-pool) fast=1;;
      *) usage;;
    esac
  done
  if [ -f "$dir/app.pid" ] && kill -0 "$(cat "$dir/app.pid")" 2>/dev/null; then
    echo "已经在跑（pid $(cat "$dir/app.pid")）"; exit 1
  fi
  local extra=()
  [ -n "$multi" ] && extra+=(APEXNODES_MULTI_BOT=1)
  [ -n "$fast" ] && extra+=(HERMES_DESKTOP_POOL_IDLE_MS=60000 HERMES_DESKTOP_POOL_KEEPALIVE_FRESH_MS=120000)
  env HERMES_HOME="$dir/home/hermes" HERMES_DESKTOP_USER_DATA_DIR="$dir/home/userdata" HERMES_DESKTOP_CWD="$dir/home/cwd" \
      HERMES_DESKTOP_IGNORE_EXISTING=1 HERMES_DESKTOP_SKIP_QUIT_CONFIRM=1 ${extra[@]+"${extra[@]}"} \
      "$dir/APEX.app/Contents/MacOS/APEX" --use-mock-keychain >>"$dir/app.log" 2>&1 &
  echo $! > "$dir/app.pid"
  echo "$(date -u +%FT%TZ) launch pid $! multi_bot=${multi:-0} fast_pool=${fast:-0}" >> "$dir/launches.log"
  echo "已启动 pid $!（多助手开关：${multi:-关}；池参数：${fast:+压缩}${fast:-默认}）"
  local t0 line=""
  t0=$(date +%s)
  for _ in $(seq 1 72); do
    sleep 5
    line=$(grep -h "bundled-engine" "$dir"/home/hermes/logs/*.log 2>/dev/null | grep -E "activated|preserving|failed" | tail -1 || true)
    [ -n "$line" ] && break
    kill -0 "$(cat "$dir/app.pid")" 2>/dev/null || { echo "App 提前退出了，看 $dir/app.log"; exit 1; }
  done
  echo "首启 $(( $(date +%s) - t0 )) 秒：${line:-还没看到 bundled-engine 行}"
}

engine_python() {
  local dir py
  dir=$(abs "$1")
  py=$(ls -t "$dir"/home/hermes/versions/*/venv/bin/python3 2>/dev/null | head -1 || true)
  [ -n "$py" ] || { echo "还没有引擎（先 launch，等自带引擎激活）"; exit 1; }
  echo "$py"
}

stop() {
  local dir pid
  dir=$(abs "$1")
  pid=$(cat "$dir/app.pid" 2>/dev/null || true)
  if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
    kill -TERM "$pid"
    for _ in $(seq 1 15); do kill -0 "$pid" 2>/dev/null || break; sleep 2; done
  fi
  local left
  left=$(pgrep -f "$dir" || true)
  if [ -z "$left" ]; then echo "测试目录下 0 个进程"; return; fi
  echo "残留进程："; ps -o pid=,ppid=,command= -p "$(echo "$left" | paste -sd, -)" | cut -c1-200
  if [ "${2:-}" = "--force" ]; then
    echo "$left" | xargs kill -TERM 2>/dev/null || true; sleep 5
    left=$(pgrep -f "$dir" || true)
    [ -n "$left" ] && echo "$left" | xargs kill -KILL 2>/dev/null || true
    echo "已清掉残留进程"
  fi
}

cleanup() {
  local dir
  dir=$(abs "$1")
  [ -f "$dir/.hc-1083-test-dir" ] || { echo "不是 prepare 建的测试目录，不动：$dir"; exit 1; }
  if pgrep -f "$dir" >/dev/null; then echo "还有进程在跑，先 stop"; exit 1; fi
  "$LSR" -u "$dir/APEX.app" 2>/dev/null || true
  for helper in "$dir"/APEX.app/Contents/Frameworks/*.app; do "$LSR" -u "$helper" 2>/dev/null || true; done
  echo "已从 LaunchServices 注销测试副本和 helper"
  echo "测试目录外留下的：~/Library/Preferences/com.apexnodes.desktop.plist 里的 StoreKit 时间戳、apexnodes 协议的修改时间（值不变）"
  if [ "${2:-}" = "--delete" ]; then rm -rf "$dir"; echo "已删除 $dir"; fi
}

case "$ACTION" in
  prepare) [ $# -eq 3 ] || usage; prepare "$2" "$3";;
  launch) shift; launch "$@";;
  python) engine_python "$2";;
  stop) stop "$2" "${3:-}";;
  cleanup) cleanup "$2" "${3:-}";;
  *) usage;;
esac
