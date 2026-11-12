"""视频画面特效元数据

APEX: 上游 0.3.1 这里是 8191 行的画面特效表，随包内置时换成空表(见 apex_overlay/vendor/README.md)。
APEX 写的剪映草稿只用本地素材和少量免费转场，不写画面特效。
"""

from .effect_meta import EffectEnum


class VideoSceneEffectType(EffectEnum):
    """视频画面特效枚举(APEX 内置版不带特效表)"""
