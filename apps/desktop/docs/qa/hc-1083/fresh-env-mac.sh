#!/usr/bin/env bash
# hc-1083：在本机起一份隔离的 APEX 打包产物（全新空环境），给多助手验收用。
#
#   fresh-env-mac.sh prepare <DMG 或 .app> <测试目录>   # 拷出 App，建空的家目录
#   fresh-env-mac.sh launch  <测试目录> [--single-thread] [--multi-bot | --multi-bot-off] [--fast-pool] [--quit-confirm]
#   fresh-env-mac.sh python  <测试目录>                  # 引擎自带 python（跑 multi_bot_qa.py 用）
#   fresh-env-mac.sh isolation <测试目录>               # 核对隔离：副本的进程都用测试目录，真实 ~/.apexnodes 的日志没动
#   fresh-env-mac.sh stop    <测试目录> [--force]        # SIGTERM 主进程，列出残留进程（含工作目录在测试目录里的孤儿）
#   fresh-env-mac.sh cleanup <测试目录> [--delete]       # 从 LaunchServices 注销，--delete 才删目录
#
# 规矩（硬规则 11 + 2026-10 的几次踩坑）：
# - 每次验收用一个新的空目录，不拿以前跑过的家目录自证；
# - 直接起 App 里的二进制，不用 open（open 会按 bundle id 找到 /Applications 里那个）；
# - HERMES_HOME / userData / 工作目录都在测试目录里，--use-mock-keychain 不碰正式版的钥匙串条目；
# - --multi-bot 同时开单线（APEXNODES_MULTI_BOT=1 + APEXNODES_SINGLE_THREAD=1）：multi_bot 只在单线也开时才算开；
#   --multi-bot-off 开单线、强制关多助手（APEXNODES_MULTI_BOT=0）：线上 v5 起 multi_bot: true，不设就是开，第 A 组要用它；
#   --single-thread 只开单线，多助手由平台定；
# - 只用最新版的安装包：比线上旧的副本会自己下载新版、空闲时装上重启，ShipIt 重启时不带这里设的环境变量，
#   会跑到本机真实的 ~/.apexnodes 上（2026-10-28 用 0.17.65 踩过）；
# - --fast-pool 把池的闲置回收压到 60 秒、保鲜窗口压到 120 秒，只用来快速摸行为，正式数字必须用默认值；
# - 默认跳过「还有任务在跑，确定退出？」，方便 stop；要验退出提示时加 --quit-confirm。
set -euo pipefail

usage() { sed -n '2,9p' "$0"; exit 2; }
[ $# -ge 2 ] || usage
ACTION=$1
LSR=/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister

abs() { (cd "$1" && pwd -P); }
REAL_LOG="$HOME/.apexnodes/logs/desktop.log"

# 真实家目录日志的「大小 修改时间」，launch 时记下，isolation 时比
real_log_mark() { if [ -f "$REAL_LOG" ]; then stat -f '%z %m' "$REAL_LOG"; else echo "absent"; fi; }

# 测试目录下的进程：命令行里有测试目录的，加上工作目录在测试目录里的（引擎起的 ffmpeg 等只带相对路径）
test_pids() {
  local dir=$1
  { pgrep -f "$dir" || true
    lsof -nP -d cwd -Fpn 2>/dev/null | awk -v d="$dir" '/^p/{p=substr($0,2)} /^n/{if (index(substr($0,2), d)==1) print p}'
  } | sort -un | while read -r pid; do
    # 本工具的 watch 和这个脚本自己（它的命令行也带测试目录）不算
    ps -o command= -p "$pid" 2>/dev/null | grep -qE "multi_bot_qa.py|fresh-env-mac.sh" || echo "$pid"
  done
}

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
  local version feed latest
  version=$(defaults read "$dir/APEX.app/Contents/Info.plist" CFBundleShortVersionString)
  echo "App 版本：$version"
  # 只用线上最新版：旧版副本会自己下载新版、空闲时装上，ShipIt 重启时不带测试目录的环境变量（2026-10-28 踩过）
  feed=$(sed -n 's/^url: *//p' "$dir/APEX.app/Contents/Resources/app-update.yml")
  latest=$(curl -fsS --max-time 15 "$feed/mac-arm64/latest-mac.yml" 2>/dev/null | sed -n 's/^version: *//p' | head -1)
  if [ -z "$latest" ]; then
    echo "读不到线上最新版本（$feed），不确定会不会自更新，停下"; rm -rf "$dir/APEX.app"; exit 1
  elif [ "$latest" != "$version" ]; then
    echo "拒绝：安装包是 $version，线上最新是 $latest。旧版副本会自更新并跑到真实家目录上"; rm -rf "$dir/APEX.app"; exit 1
  fi
  echo "线上最新版也是 $latest"
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
  local dir single="" multi="" fast="" confirm=""
  dir=$(abs "$1"); shift
  [ -f "$dir/.hc-1083-test-dir" ] || { echo "不是 prepare 建的测试目录：$dir"; exit 1; }
  for flag in "$@"; do
    case "$flag" in
      --single-thread) single=1;;
      --multi-bot) multi=1; single=1;;
      --multi-bot-off) multi=0; single=1;;
      --fast-pool) fast=1;;
      --quit-confirm) confirm=1;;
      *) usage;;
    esac
  done
  if [ -f "$dir/app.pid" ] && kill -0 "$(cat "$dir/app.pid")" 2>/dev/null; then
    echo "已经在跑（pid $(cat "$dir/app.pid")）"; exit 1
  fi
  local extra=()
  [ -z "$confirm" ] && extra+=(HERMES_DESKTOP_SKIP_QUIT_CONFIRM=1)
  [ -n "$single" ] && extra+=(APEXNODES_SINGLE_THREAD=1)
  [ -n "$multi" ] && extra+=(APEXNODES_MULTI_BOT=$multi)
  [ -n "$fast" ] && extra+=(HERMES_DESKTOP_POOL_IDLE_MS=60000 HERMES_DESKTOP_POOL_KEEPALIVE_FRESH_MS=120000)
  env HERMES_HOME="$dir/home/hermes" HERMES_DESKTOP_USER_DATA_DIR="$dir/home/userdata" HERMES_DESKTOP_CWD="$dir/home/cwd" \
      HERMES_DESKTOP_IGNORE_EXISTING=1 ${extra[@]+"${extra[@]}"} \
      "$dir/APEX.app/Contents/MacOS/APEX" --use-mock-keychain >>"$dir/app.log" 2>&1 &
  echo $! > "$dir/app.pid"
  real_log_mark > "$dir/real-home-log.mark"
  echo "$(date -u +%FT%TZ) launch pid $! single_thread=${single:-unset} multi_bot=${multi:-unset} fast_pool=${fast:-0}" >> "$dir/launches.log"
  local st="平台定" mb="平台定" pool="默认"
  [ -n "$single" ] && st="开"
  [ "$multi" = 1 ] && mb="开"
  [ "$multi" = 0 ] && mb="关（强制）"
  [ -n "$fast" ] && pool="压缩"
  echo "已启动 pid $(cat "$dir/app.pid")（单线：$st；多助手：$mb；池参数：$pool）"
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

isolation() {
  local dir bad=0 pid home
  dir=$(abs "$1")
  for pid in $(pgrep -f "$dir/APEX.app/Contents/" || true); do
    home=$(ps eww -o command= -p "$pid" 2>/dev/null | tr ' ' '\n' | sed -n 's/^HERMES_HOME=//p' | head -1)
    if [ "$home" != "$dir/home/hermes" ]; then
      echo "FAIL pid $pid 的 HERMES_HOME 是「${home:-没设}」，不是测试目录"; bad=1
    fi
  done
  if [ -f "$dir/real-home-log.mark" ] && [ "$(real_log_mark)" != "$(cat "$dir/real-home-log.mark")" ]; then
    echo "FAIL 真实 $REAL_LOG 在本次启动后变了：$(cat "$dir/real-home-log.mark") -> $(real_log_mark)"; bad=1
  fi
  if pgrep -f "/Applications/APEX.app/Contents/MacOS/APEX" >/dev/null; then
    echo "注意：/Applications/APEX.app 在跑，computer use 分不清两个窗口"
  fi
  [ "$bad" = 0 ] && echo "PASS 隔离还在：副本进程都用测试目录，真实家目录的日志没动"
  return "$bad"
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
  left=$(test_pids "$dir")
  if [ -z "$left" ]; then echo "测试目录下 0 个进程"; return; fi
  echo "残留进程（ppid 1 的是孤儿）："; ps -o pid=,ppid=,command= -p "$(echo "$left" | paste -sd, -)" | cut -c1-200
  if [ "${2:-}" = "--force" ]; then
    echo "$left" | xargs kill -TERM 2>/dev/null || true; sleep 5
    left=$(test_pids "$dir")
    [ -n "$left" ] && echo "$left" | xargs kill -KILL 2>/dev/null || true
    echo "已清掉残留进程"
  fi
}

cleanup() {
  local dir
  dir=$(abs "$1")
  [ -f "$dir/.hc-1083-test-dir" ] || { echo "不是 prepare 建的测试目录，不动：$dir"; exit 1; }
  if [ -n "$(test_pids "$dir")" ]; then echo "还有进程在跑，先 stop"; exit 1; fi
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
  isolation) isolation "$2";;
  stop) stop "$2" "${3:-}";;
  cleanup) cleanup "$2" "${3:-}";;
  *) usage;;
esac
