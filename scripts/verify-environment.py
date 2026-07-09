#!/usr/bin/env python3
"""verify-environment.py — 校验某版本的 agent 环境是否在 COS 上齐全(github-free 不变量的闸)。

读 apexnodes-environment.yaml,对给定 runtime commit,HEAD-check 每个 COS 自托管产物
(runtime tarball / uv per-triple / PortableGit per-arch)是否 200。缺任一 → 非零退出。
**发版 / 翻 is_default 前跑它**:防 hc-448 类(发的版本环境没全上 COS → 大陆装机回落 github → 炸)。

用法:
  python3 scripts/verify-environment.py --commit <full-sha> [--manifest PATH] [--json]
"""
import argparse
import json
import os
import sys
import urllib.error
import urllib.request


def head(url, timeout=10):
    try:
        with urllib.request.urlopen(urllib.request.Request(url, method="HEAD"), timeout=timeout) as r:
            return r.status
    except urllib.error.HTTPError as e:
        return e.code
    except Exception:
        return 0


def load_manifest(path):
    try:
        import yaml
    except ImportError:
        sys.exit("verify-environment: 需要 PyYAML (pip install pyyaml)")
    with open(path, encoding="utf-8") as f:
        return yaml.safe_load(f)


def cos_urls(m, commit):
    """yield (label, url|None) — 每个必须存在的 COS 产物。"""
    base = m["cos_base"].rstrip("/")
    for art in m.get("cos_artifacts", []):
        name = art["name"]
        by = art.get("keyed_by")
        if by == "commit":
            if not commit:
                yield (name, None)
                continue
            yield (f"{name}[{commit[:10]}]", f"{base}/{art['key'].format(commit=commit)}")
        elif by == "triple":
            for t in art["triples"]:
                key = art["key"].format(triple=t["triple"], ext=t["ext"])
                yield (f"{name}[{t['triple']}]", f"{base}/{key}")
        elif by == "arch":
            ver = art["version"]
            for a in art["arches"]:
                key = art["key"].format(version=ver, arch=a)
                yield (f"{name}[{a}]", f"{base}/{key}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--commit", help="runtime 完整 SHA(runtime-source tarball 用)")
    ap.add_argument("--manifest", default=os.path.join(os.path.dirname(__file__), "..", "apexnodes-environment.yaml"))
    ap.add_argument("--json", action="store_true")
    args = ap.parse_args()

    m = load_manifest(args.manifest)
    results = []
    ok = True
    for name, url in cos_urls(m, args.commit):
        if url is None:
            results.append((name, "SKIP", "缺 --commit,无法校验 runtime tarball"))
            ok = False
            continue
        code = head(url)
        good = 200 <= code < 300
        results.append((name, "OK" if good else f"MISS({code})", url))
        ok = ok and good

    reg = [(r["name"], head(r["mirror"].split("/simple")[0])) for r in m.get("cn_registry", [])]

    if args.json:
        print(json.dumps({
            "ok": ok,
            "cos": [{"name": n, "status": s, "url": u} for n, s, u in results],
            "cn_registry": [{"name": n, "http": c} for n, c in reg],
        }, ensure_ascii=False, indent=2))
    else:
        print(f"=== COS 产物 (commit={args.commit or '<none>'}) ===")
        for n, s, _ in results:
            print(f"  [{s:>9}] {n}")
        print("=== cn_registry 可达性(仅参考)===")
        for n, c in reg:
            print(f"  [{c}] {n}")
        na = m.get("needs_audit", [])
        if na:
            print(f"=== needs_audit ({len(na)}) — 源未确认,未纳入闸 ===")
            for x in na:
                print(f"  - {x['name']}: {x.get('note', '')}")
        print(f"\nRESULT: {'PASS — 环境已全镜像' if ok else 'FAIL — 上面有缺失镜像'}")
    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main()
