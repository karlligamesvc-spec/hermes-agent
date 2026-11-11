"""滤镜效果元数据

APEX: 上游 0.3.1 这里是 2799 行的滤镜表，随包内置时换成空表(见 apex_overlay/vendor/README.md)。
APEX 写的剪映草稿只用本地素材和少量免费转场，不写滤镜。
"""

from .effect_meta import EffectEnum


class FilterType(EffectEnum):
    """滤镜效果类型(APEX 内置版不带滤镜表)"""
