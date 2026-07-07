"""Unit tests for the plugin-specific glue in usage-hud/__init__.py - the
pieces that are NOT already covered by test_fixtures.py's conformance run
against core.py. agent.usage_pricing / agent.model_metadata aren't installed
in this test environment, so _build_snapshot's cost/context lookups take
their except-branches and degrade gracefully - which is itself the behavior
under test (a missing Hermes install must not crash the plugin).
"""
import importlib.util
import sys
import types
import unittest
from pathlib import Path

PLUGIN_DIR = Path(__file__).resolve().parents[1] / "usage-hud"

# Load __init__.py the SAME way Hermes's real plugin loader does
# (hermes_cli/plugins.py: PluginManager._load_init_module), not via a
# sys.path shortcut. A prior version of this test used
# `sys.path.insert(0, str(PLUGIN_DIR))` + a bare `spec_from_file_location`
# with no submodule_search_locations/__package__/__path__ - that let
# __init__.py's own `import core` (a bare, non-relative import) resolve via
# sys.path in the TEST, while under Hermes's actual loader the plugin
# directory is never added to sys.path (only registered as the package's
# __path__ for relative imports), so `import core` raised ModuleNotFoundError
# and the whole plugin silently failed to load. Fixed to `from . import core`
# in __init__.py; this harness now reproduces the real loader exactly so that
# class of bug fails a test instead of only failing in production.
_NS_PARENT = "_usage_hud_test_ns"
if _NS_PARENT not in sys.modules:
    _ns_pkg = types.ModuleType(_NS_PARENT)
    _ns_pkg.__path__ = []
    sys.modules[_NS_PARENT] = _ns_pkg

_module_name = f"{_NS_PARENT}.usage_hud"
_spec = importlib.util.spec_from_file_location(
    _module_name, PLUGIN_DIR / "__init__.py", submodule_search_locations=[str(PLUGIN_DIR)]
)
plugin = importlib.util.module_from_spec(_spec)
plugin.__package__ = _module_name
plugin.__path__ = [str(PLUGIN_DIR)]
sys.modules[_module_name] = plugin
_spec.loader.exec_module(plugin)


class BuildSnapshotTests(unittest.TestCase):
    def test_maps_usage_dict_to_tokens(self):
        snapshot = plugin._build_snapshot(
            model="claude-opus-4-8",
            provider="anthropic",
            base_url="",
            usage={
                "input_tokens": 1200,
                "output_tokens": 340,
                "cache_read_tokens": 500,
                "cache_write_tokens": 0,
                "total_tokens": 1540,
                "prompt_tokens": 1700,
            },
            session_id="s1",
            platform="telegram",
        )
        self.assertEqual(snapshot["model"], "claude-opus-4-8")
        self.assertEqual(snapshot["provider"], "anthropic")
        self.assertEqual(
            snapshot["tokens"],
            {"input": 1200, "output": 340, "cacheRead": 500, "cacheWrite": 0, "total": 1540},
        )
        self.assertEqual(snapshot["route"], {"sessionKey": "s1", "channel": "telegram"})
        # agent.usage_pricing / agent.model_metadata aren't installed here,
        # so cost/context must be omitted, not crash or default to 0.
        self.assertNotIn("cost", snapshot)
        self.assertNotIn("context", snapshot)

    def test_returns_none_without_model(self):
        self.assertIsNone(
            plugin._build_snapshot(model="", provider="", base_url="", usage=None, session_id="s1", platform="")
        )

    def test_no_usage_means_no_tokens_segment(self):
        snapshot = plugin._build_snapshot(
            model="claude-opus-4-8", provider="", base_url="", usage=None, session_id="s1", platform=""
        )
        self.assertEqual(snapshot, {"model": "claude-opus-4-8", "route": {"sessionKey": "s1", "channel": ""}})


class LoadConfigFromEnvTests(unittest.TestCase):
    def setUp(self):
        self._saved = {k: v for k, v in __import__("os").environ.items() if k.startswith("USAGE_HUD_")}
        for k in self._saved:
            del __import__("os").environ[k]

    def tearDown(self):
        import os

        for k in list(os.environ):
            if k.startswith("USAGE_HUD_"):
                del os.environ[k]
        os.environ.update(self._saved)

    def test_defaults_when_unset(self):
        config = plugin._core.resolve_config(plugin._load_config_from_env())
        self.assertTrue(config["footer"]["enabled"])
        self.assertEqual(config["command"]["name"], "cost")
        self.assertEqual(config["alerts"]["context"]["thresholdPct"], 80)

    def test_reads_overrides(self):
        import os

        os.environ["USAGE_HUD_FOOTER_ENABLED"] = "false"
        os.environ["USAGE_HUD_ALERT_CONTEXT_THRESHOLD_PCT"] = "90"
        os.environ["USAGE_HUD_FOOTER_FIELDS"] = "model,cost"
        config = plugin._core.resolve_config(plugin._load_config_from_env())
        self.assertFalse(config["footer"]["enabled"])
        self.assertEqual(config["alerts"]["context"]["thresholdPct"], 90)
        self.assertEqual(config["footer"]["fields"], ["model", "cost"])


if __name__ == "__main__":
    unittest.main()
