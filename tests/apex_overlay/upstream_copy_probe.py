"""hc-1116: the open-source engine's wording that can reach an APEX user, printed from one process.

test_upstream_copy_exits.py runs this once per surface; the environment decides which one (nothing set:
plain engine or Desktop with single-thread mode off; ``APEX_SINGLE_THREAD_ACTIVE=1``: Desktop's single-thread
mode; ``HERMES_MANAGED_RUNTIME=1``: a cloud container). It loads the bundled apex-overlay plugin the way
plugin discovery does, then prints every exit as one JSON object:

* both first-contact notes (the one-shot note on the first message to a new assistant, in Desktop and IM);
* the Desktop platform hint and the mid-turn steering note, as the system prompt reads them;
* every catalog line in zh and en that names Hermes, a ``hermes`` command, Nous, /help, /model or /login
  (``gateway``, ``explainer``, ``approval``, ``slash`` and ``platform`` keys of the bundled catalogs);
* the no-home-channel notice as apex_overlay/cn_im_messages.py rewrites it for WeChat from English.
"""

from __future__ import annotations

import importlib.util
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))

# What counts as upstream wording in a catalog line.
UPSTREAM_WORDS = re.compile(r"Hermes|hermes [a-z]|/help|Nous|/model|/login", re.IGNORECASE)
CATALOG_PREFIXES = ("gateway.", "explainer.", "approval.", "slash.", "platform.")
CATALOG_LANGUAGES = ("zh", "en")


def _load_plugin() -> None:
    from hermes_cli import plugins
    from hermes_cli.plugins import PluginContext, PluginManager, PluginManifest

    manager = PluginManager()
    manager._discovered = True
    plugins._plugin_manager = manager
    spec = importlib.util.spec_from_file_location("apex_overlay_plugin", ROOT / "plugins" / "apex-overlay" / "__init__.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    module.register(PluginContext(PluginManifest(name="apex-overlay", key="apex-overlay", source="bundled"), manager))


def upstream_keys() -> list[str]:
    """Catalog keys whose bundled zh or en line has upstream wording (the bundled files, not what t() serves)."""
    from agent import i18n_layers

    bundled = [i18n_layers.parse_locale_file(ROOT / "locales" / f"{lang}.yaml") for lang in CATALOG_LANGUAGES]
    keys = {key for catalog in bundled for key, text in catalog.items()
            if key.startswith(CATALOG_PREFIXES) and UPSTREAM_WORDS.search(text)}
    return sorted(keys)


def _first_contact(home: Path, mode: str) -> str:
    from agent.onboarding import first_contact_turn_note

    path = home / f"config-{mode}.yaml"
    return first_contact_turn_note({"onboarding": {"profile_build": mode}}, path, session_history_empty=True,
                                   install_has_prior_sessions=False)


def main() -> None:
    _load_plugin()

    from agent import system_prompt
    from agent.i18n import t
    from apex_overlay import cn_im_messages
    from hermes_constants import get_hermes_home

    home = get_hermes_home()
    keys = upstream_keys()
    exits = {
        "first-contact-note": _first_contact(home, "off"),
        "first-contact-profile-offer": _first_contact(home, "ask"),
        "desktop-platform-hint": system_prompt.PLATFORM_HINTS["desktop"],
        "steer-note": system_prompt.STEER_CHANNEL_NOTE,
        **{f"catalog-{lang}": "".join(f"{key}\t{json.dumps(t(key, lang=lang), ensure_ascii=False)}\n" for key in keys)
           for lang in CATALOG_LANGUAGES},
        "cn-im-no-home-channel": cn_im_messages._hc228_localize(
            "weixin", t("gateway.notify.no_home_channel", lang="en", platform="weixin", sethome_cmd="/sethome")),
    }
    print(json.dumps(exits, ensure_ascii=False))


if __name__ == "__main__":
    main()
