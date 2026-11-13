"""hc-1223: an execute_code script that only reads files runs without an approval card.

The record (APEX Desktop 0.17.76, 2026-11-11): of the 18 execute_code cards in one 87-minute run,
five were scripts that only read: two printed transcript JSON, one measured the presenter's head
in four PNG frames with PIL and numpy, one printed part of the agent's own render script. They
are below verbatim. The other thirteen edited the agent's own scripts in place (read, replace,
write back); writing is not reading, so those keep their card, and so does everything that writes,
spawns, connects or reaches past the allowlist in ``tools.approval_readonly``.
"""

from __future__ import annotations

import pytest

from tools import approval as A
from tools import approval_context, approval_hold, approval_turn_grant
from tools.approval_readonly import is_readonly_script

SESSION = "readonly-session"

RECORD_READ_ONLY = {  # verbatim, but for the home folder
    "print a transcript": r'''import json,re
p="/Users/me/apex-zx-test/home/hermes/cache/documents/参考-EP06_逐字稿_2b0e4c4f.segments.json"
d=json.load(open(p))
print(type(d), list(d)[:5] if isinstance(d,dict) else len(d))
print(json.dumps(d, ensure_ascii=False)[:1200])
''',
    "speech rate of two transcripts": r'''import json,re
def rate(p, dur):
    d=json.load(open(p))
    txt="".join(s.get("text","") for s in d)
    chars=len(re.sub(r"[，。！？、,.!?\s]","",txt))
    speech=(d[-1]["end_time"]-d[0]["start_time"])/1000
    print(p.split("/")[-1], "chars",chars, "speech_s",round(speech,2), "c/s",round(chars/speech,2), "c/min",round(chars/speech*60))
    # gaps between segments
    gaps=[(d[i+1]["start_time"]-d[i]["end_time"])/1000 for i in range(len(d)-1)]
    print("  gaps:",[round(g,2) for g in gaps], "median", round(sorted(gaps)[len(gaps)//2],2) if gaps else None)
    print("  segs:", [(s['start_time'],s['end_time'],s['text']) for s in d])
rate("/Users/me/apex-zx-test/home/hermes/cache/documents/参考-EP06_逐字稿_2b0e4c4f.segments.json",31.7)
rate("/Users/me/apex-zx-test/home/hermes/cache/documents/EP07-成片_逐字稿_717f18da.segments.json",30.2)
''',
    "head size in four frames": r'''from PIL import Image
import numpy as np

def analyze(path, label):
    im = Image.open(path).convert("RGB")
    if im.size != (1080,1920):
        # ref is 1080x1920, A2 is 768x1344
        pass
    a = np.asarray(im).astype(float)
    W,H = im.size
    lum = a.mean(axis=2)
    # subject mask: brighter than background. background near-black (<40)
    mask = lum > 55
    rows = mask.mean(axis=1)
    ys = np.where(rows>0.03)[0]
    top = ys[0] if len(ys) else -1
    # horizontal extent per row
    def extent(y):
        xs = np.where(mask[y])[0]
        return (xs.min(), xs.max()) if len(xs) else (None,None)
    # head width: sample the row at 6% below top .. find max extent in first 25% of subject height
    best=(0,None)
    for y in range(top, min(H, top+int(0.35*(H-top)))):
        x0,x1 = extent(y)
        if x0 is not None and (x1-x0)>best[0]:
            best=(x1-x0,y)
    print(f"{label}: size={W}x{H} top={top} ({top/H:.1%}) headwidest={best[0]}px ({best[0]/W:.1%}W) at y={best[1]} ({best[1]/H:.1%}) rows>0.03 from {top} to {ys[-1]}")
    return

analyze("/Users/me/apex-zx-test/home/cwd/EP07-A2/_work/ref/ep06-14.png","EP06 ref")
analyze("/Users/me/apex-zx-test/home/cwd/EP07-A2/_work/ref/ep07old-12.png","EP07 old")
analyze("/Users/me/apex-zx-test/home/cwd/EP07-A2/_work/host/A2-f9.png","A2 wide")
analyze("/Users/me/apex-zx-test/home/cwd/EP07-A2/_work/host/A-f8.png","A close")
''',
    "two transcripts side by side": r'''import json
for p in ["/Users/me/apex-zx-test/home/hermes/cache/documents/subject_definitions_逐字稿_b40fd739.segments.json",
          "/Users/me/apex-zx-test/home/hermes/cache/documents/subject_definitions_逐字稿_b351d580.segments.json"]:
    d=json.load(open(p))
    print(p.split("/")[-1])
    for s in d:
        print("  ", s["start_time"], s["end_time"], s["text"])
''',
    "a slice of its own script": r'''import re
p = "/Users/me/apex-zx-test/home/cwd/EP07-A2/_work/render_panel.py"
src = open(p, encoding="utf-8").read()
start = src.index("def title(img, t, l1, l2")
end = src.index("SCENES = [")
print(len(src), start, end)
print(src[start-200:start])
''',
}

RECORD_WRITE_BACK = (  # one of the thirteen in-place edits, verbatim
    'p="/Users/me/apex-zx-test/home/cwd/EP07-A2/工程笔记.md"\n'
    's=open(p,encoding="utf-8").read()\n'
    's=s.replace("7 个场景，切换时交叉淡化 0.24 秒", "7 个场景，硬切过场")\n'
    'open(p,"w",encoding="utf-8").write(s)\n'
    'print("ok")\n')

READ = 'src = open("notes.txt").read()\n'

STILL_ASKS = {
    "record: edit its own script in place": RECORD_WRITE_BACK,
    "append mode": READ + 'open("notes.txt", "a").write(src)\n',
    "mode keyword": READ + 'open("out.txt", mode="w")\n',
    "read-write mode": 'print(open("notes.txt", "r+").read())\n',
    "Path.write_text": 'from pathlib import Path\nPath("b").write_text(Path("a").read_text())\n',
    "Path.replace renames": 'from pathlib import Path\nprint(Path("a").read_text())\nPath("a").replace("b")\n',
    "Path.unlink": 'from pathlib import Path\nprint(Path("a").read_text())\nPath("a").unlink()\n',
    "Path.copy takes a target": 'from pathlib import Path\nprint(Path("a").read_text())\nPath("a").copy("b")\n',
    "os.remove": 'import os\nprint(open("a").read())\nos.remove("a")\n',
    "os.system": 'import os\nprint(open("a").read())\nos.system("rm -rf build")\n',
    "a module through another module": 'import os.path\nprint(open("a").read())\nos.path.os.remove("a")\n',
    "a module PIL imports": 'import PIL.Image as I\nprint(open("a").read())\nI.os.remove("a")\n',
    "subprocess": 'import subprocess\nprint(open("a").read())\nsubprocess.run(["ls"])\n',
    "socket": 'import socket\nprint(open("a").read())\n',
    "urllib": 'import urllib.request\nprint(urllib.request.urlopen("http://x").read(), open("a").read())\n',
    "pickle": 'import pickle\nprint(pickle.load(open("a", "rb")))\n',
    "shutil.rmtree": 'import shutil\nprint(open("a").read())\nshutil.rmtree("build")\n',
    "the hermes_tools bridge": 'from hermes_tools import terminal\nprint(open("a").read())\nterminal("rm -rf x")\n',
    "exec": 'exec(open("a").read())\n',
    "eval": 'print(eval(open("a").read()))\n',
    "__import__": 'print(open("a").read())\n__import__("os").remove("a")\n',
    "getattr": 'import os\nprint(open("a").read())\ngetattr(os, "remove")("a")\n',
    "a dunder escape": 'print(open("a").read().__class__.__mro__)\n',
    "open passed around": 'f = open\nprint(f("a").read())\nf("b", "w")\n',
    "print into a file": 'print(open("a").read(), file=open("b", "a"))\n',
    "PIL save": 'from PIL import Image\nImage.open("a.png").save("b.png")\n',
    "PIL show opens a viewer": 'from PIL import Image\nImage.open("a.png").show()\n',
    "numpy save": 'import numpy as np\nnp.save("b.npy", np.fromfile("a"))\n',
    "numpy pickle load": 'import numpy as np\nprint(np.load("a.npy", allow_pickle=True), open("a").read())\n',
    "wave write": 'import wave\nprint(open("a").read())\nw = wave.open("b.wav", "wb")\n',
    "unbound method": 'from pathlib import Path\np = Path("a")\nprint(p.read_text())\ntype(p).write_text(p, "x")\n',
    "a class": 'class X:\n    pass\nprint(open("a").read())\n',
    "a decorator": 'import functools\n@functools.cache\ndef f():\n    return open("a").read()\nprint(f())\n',
    "a module as a value": 'import os\nm = os\nprint(open("a").read())\n',
}


@pytest.fixture
def gateway(monkeypatch):
    """A gateway session whose cards are recorded and denied."""
    monkeypatch.setenv("HERMES_GATEWAY_SESSION", "1")
    for var in ("HERMES_INTERACTIVE", "HERMES_CRON_SESSION", "HERMES_EXEC_ASK"):
        monkeypatch.delenv(var, raising=False)
    monkeypatch.setattr(approval_context, "_get_approval_mode", lambda: "manual")
    monkeypatch.setattr(A, "_YOLO_MODE_FROZEN", False)
    cards: list[dict] = []

    def notify(data):
        cards.append(data)
        with A._lock:
            entry = A._gateway_queues[SESSION][-1]
            entry.result = "deny"
            entry.event.set()

    key_token = approval_context.set_current_session_key(SESSION)
    turn_tokens = approval_context.set_current_observability_context(turn_id="turn-1")
    with A._lock:
        A._session_approved.pop(SESSION, None)
        A._gateway_notify_cbs[SESSION] = notify
    approval_hold.clear(SESSION)
    approval_turn_grant.revoke(SESSION)
    try:
        yield cards
    finally:
        approval_context.reset_current_observability_context(turn_tokens)
        approval_context.reset_current_session_key(key_token)
        approval_hold.clear(SESSION)
        with A._lock:
            A._gateway_notify_cbs.pop(SESSION, None)
            A._gateway_queues.pop(SESSION, None)


@pytest.mark.parametrize("script", list(RECORD_READ_ONLY.values()), ids=list(RECORD_READ_ONLY))
def test_record_read_only_scripts_run_without_a_card(gateway, script):
    assert A.check_execute_code_guard(script, "local")["approved"] is True
    assert gateway == []


@pytest.mark.parametrize("script", list(STILL_ASKS.values()), ids=list(STILL_ASKS))
def test_scripts_that_write_spawn_connect_or_escape_still_ask(gateway, script):
    result = A.check_execute_code_guard(script, "local")
    assert result["approved"] is False
    assert [card["pattern_key"] for card in gateway] == ["execute_code"]


@pytest.mark.parametrize("script", ["print('hi')", "import os; os.listdir('.')", "x = 1 + 1"])
def test_a_script_that_reads_no_file_is_not_read_only(script):
    """Only reading files earns the exemption; these keep standing in for "some script" in gate tests."""
    assert is_readonly_script(script) is False


def test_read_only_scripts_still_run_after_a_refusal(gateway):
    """Like a hc-1034 probe, a read-only script is not held after a denied approval in the turn."""
    assert A.check_all_command_guards("rm -rf build", "local")["outcome"] == "denied"
    script = RECORD_READ_ONLY["a slice of its own script"]
    assert A.check_execute_code_guard(script, "local")["approved"] is True
    assert A.check_execute_code_guard(RECORD_WRITE_BACK, "local")["outcome"] == "denied"
    assert len(gateway) == 2
