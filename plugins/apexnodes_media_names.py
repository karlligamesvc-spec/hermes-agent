"""hc-1243: the name a generated image or video gets from the prompt that made it.

hc-1130 names a generated file after the start of its prompt's first sentence: the
gateway leg saves it as ``<hint>_<8 hex>.<ext>`` (``apexnodes_gateway.download_media``)
and the Desktop result card titles it from that name (``mediaShortTitle`` in
``apps/desktop/src/lib/media.ts``).

A prompt laid out for the model opens with its own layout, not with what the result
shows. MiniMax H3 prompts (the platform skill ``video-shot-prompts``,
``references/minimax-h3.md``) start with section labels (``subject_definitions:``) and
call what they reference by tag (``<Subject 1>``, ``<Picture 1>``, ``[Shot 1]``), so every
H3 clip was saved as ``subject_definitions_<hash>.mp4`` and listed as
「subject definitions」. Our skills have Chinese prompts call the input images
「图片1」「图片2」, and a prompt that opens by saying which pictures show whom
(「图片1 和图片2 是同一位女士」) describes the inputs, not the result.

None of that is a name. The name is, in order:

1. the first spoken line (H3 writes ``<d>[Chinese] 早上就靠它了，一口下去人就醒了。</d>``):
   the clip's own first words, in the language the user writes in;
2. what the first subject is (``<Subject 1> is the frosted white glass dropper serum
   bottle in <Picture 1>: …`` → ``frosted white glass``);
3. otherwise the first sentence, as in hc-1130, with section labels (``summary:``,
   「镜头1：」), H3's first-frame line and every reference tag taken out.

A first sentence that only says what the reference pictures are gives no name: the
caller's generic stem stays (``generated_video``, ``image``), and the result card says
「视频」 or 「图片」. The prompt itself is never changed: it is written for the model.
"""

from __future__ import annotations

import re

# hc-1130's sentence end: CJK punctuation, a line break, or ASCII punctuation followed by
# a space or the end (so 「12.5 秒」 and 「9:16」 stay whole).
_SENTENCE_END = re.compile(r"[，。！？；：\n]|[,.;:!?](?:\s|$)")

# A label at the start of a line: H3's sections (every lowercase snake_case label, and
# summary:), a short English label (Scene:, Shot 1:) and a short Chinese one (人物：、镜头1：).
_LABEL = re.compile(
    r"^[ \t]*(?:[a-z]+(?:_[a-z]+)+|[A-Za-z][a-z]{1,11}(?: \d{1,2})?|[\u4e00-\u9fff]{1,4}\d{0,2})"
    r"[ \t]*(?:：|:(?=\s|$))[ \t]*",
    re.MULTILINE,
)

# H3's first-frame mode opens with one line that binds <Picture 1> to the first frame.
_FIRST_FRAME_LINE = re.compile(
    r"^[ \t]*For the target video\b[^\n]*", re.MULTILINE | re.IGNORECASE
)

_SPOKEN_LINE = re.compile(r"<d>\s*(?:\[[^\]\n]*\]\s*)?(.*?)\s*</d>", re.DOTALL)

_SUBJECT_DEFINITION = re.compile(
    r"^\s*<\s*Subject\s*\d+\s*>\s*(?:is\s+|是\s*)(.+)", re.DOTALL | re.IGNORECASE
)

_ARTICLE = re.compile(r"^(?:the|an?)\s+", re.IGNORECASE)

_PICTURE = r"(?:<\s*(?:Picture|Image)\s*\d+\s*>|图片\s*\d+)"

# 「图片1 和图片2 是同一位女士」, 「图片1、2 都是她」, "<Picture 1> and <Picture 2> show the same woman".
_PICTURES_BINDING = re.compile(
    rf"^\s*{_PICTURE}(?:\s*(?:,|、|和|与|跟|及|and|&)?\s*(?:{_PICTURE}|\d+))*\s*"
    r"(?:是|为|都是|均为|就是|(?:is|are|shows?)(?![A-Za-z]))",
    re.IGNORECASE,
)

# A picture reference with the words that tie it into the sentence: "the woman in
# <Picture 1>", "the same outfit as in <Picture 1>", "<Picture 2>'s coat", 「图片1 的女生」.
_PICTURE_PHRASE = re.compile(
    r"\s*\b(?:as in|shown in|in|from|of|like)\s+<\s*(?:Picture|Image)\s*\d+\s*>"
    r"|<\s*(?:Picture|Image)\s*\d+\s*>'s"
    r"|图片\s*\d+\s*(?:里|中|上)?\s*的",
    re.IGNORECASE,
)

_TAG = re.compile(
    r"<\s*/?\s*(?:Picture|Image|Subject|d)\s*\d*\s*>"
    r"|\[(?:Shot\s*\d+|reference generation|Chinese|English)\]"
    r"|\(S\d+\)"
    r"|图片\s*\d+",
    re.IGNORECASE,
)

_WORD = re.compile(r"\w")
_LATIN = re.compile(r"[A-Za-z0-9'-]")
_WORD_END = re.compile(r"[A-Za-z0-9'-]{0,4}(?![A-Za-z0-9'-])")


def _first_clause(text: str) -> str:
    """The first stretch up to a sentence end that holds a word."""
    for part in _SENTENCE_END.split(text):
        if _WORD.search(part):
            return part.strip()
    return ""


def _cut(name: str, limit: int) -> str:
    """About ``limit`` characters. A cut inside a space-separated word finishes the word
    when it ends within four more letters ("young East Asian woman"), else drops it."""
    name = " ".join(name.split())
    if len(name) <= limit:
        return name
    head = name[:limit]
    if _LATIN.match(name[limit]) and _LATIN.match(head[-1]):
        rest = _WORD_END.match(name, limit)
        if rest:
            head += rest.group(0)
        elif " " in head:
            head = head.rsplit(" ", 1)[0]
    return head.strip()


def media_title_hint(prompt: str, limit: int = 20) -> str:
    """生成文件的名字:提示词第一句的开头(hc-1130);写给模型看的格式不算名字(hc-1243,见模块说明)。"""
    text = (prompt or "").strip()
    spoken = _SPOKEN_LINE.search(text)
    line = _first_clause(spoken.group(1)) if spoken else ""
    if line:
        return _cut(line, limit)
    text = _LABEL.sub("", _FIRST_FRAME_LINE.sub("", text)).strip()
    definition = _SUBJECT_DEFINITION.match(text)
    if definition:
        text = _ARTICLE.sub("", definition.group(1).strip())
    if _PICTURES_BINDING.match(_first_clause(text)):
        return ""
    return _cut(_first_clause(_TAG.sub("", _PICTURE_PHRASE.sub("", text))), limit)
