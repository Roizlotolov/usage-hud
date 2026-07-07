"""Runs the shared spec/fixtures/*.json vectors against the Python port of
core-ts, so the TypeScript and Python implementations can't silently drift.
See SPEC.md sec 5 (Conformance).
"""
import importlib.util
import json
import unittest
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[3]
FIXTURES_DIR = REPO_ROOT / "spec" / "fixtures"
PLUGIN_DIR = Path(__file__).resolve().parents[1] / "usage-hud"

# Load core.py directly by file path instead of sys.path.insert(). A global
# sys.path mutation here previously leaked into other test modules when run
# together via `unittest discover` (both files execute in the same process),
# which silently masked a real bug in __init__.py's own import of core.py -
# see the comment in test_mapping.py for the full story.
_spec = importlib.util.spec_from_file_location("usage_hud_core", PLUGIN_DIR / "core.py")
core = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(core)


def _read_json(name: str):
    with open(FIXTURES_DIR / name, encoding="utf-8") as f:
        return json.load(f)


def _read_text(name: str) -> str:
    with open(FIXTURES_DIR / name, encoding="utf-8") as f:
        return f.read()


class FixtureConformanceTests(unittest.TestCase):
    def test_footer_fixtures(self):
        for path in sorted(FIXTURES_DIR.glob("footer-*.json")):
            if path.name.endswith(".expected.json"):
                continue
            with self.subTest(fixture=path.name):
                fixture = json.loads(path.read_text(encoding="utf-8"))
                base = path.name.removesuffix(".json")
                config = core.resolve_config(fixture.get("config"))
                actual = core.format_footer(fixture["snapshot"], config)
                expected = _read_text(f"{base}.expected.txt")
                self.assertEqual(actual, expected)

    def test_on_demand_fixtures(self):
        for path in sorted(FIXTURES_DIR.glob("on-demand-*.json")):
            with self.subTest(fixture=path.name):
                fixture = json.loads(path.read_text(encoding="utf-8"))
                base = path.name.removesuffix(".json")
                actual = core.format_on_demand(fixture["snapshot"])
                expected = _read_text(f"{base}.expected.txt")
                self.assertEqual(actual, expected)

    def test_alert_cooldown_sequence(self):
        fixture = _read_json("alert-cooldown-sequence.json")
        config = core.resolve_config(fixture.get("config"))
        engine = core.AlertEngine(config)
        actual = [engine.evaluate(step["snapshot"], step["nowMs"]) for step in fixture["sequence"]]
        expected = _read_json("alert-cooldown-sequence.expected.json")
        self.assertEqual(actual, expected)

    def test_alert_fixtures(self):
        for path in sorted(FIXTURES_DIR.glob("alert-*.json")):
            if path.name.endswith(".expected.json"):
                continue
            base = path.name.removesuffix(".json")
            if base == "alert-cooldown-sequence":
                continue  # handled by test_alert_cooldown_sequence (stateful sequence, not a single snapshot)
            with self.subTest(fixture=path.name):
                fixture = json.loads(path.read_text(encoding="utf-8"))
                config = core.resolve_config(fixture.get("config"))
                engine = core.AlertEngine(config)
                actual = engine.evaluate(fixture["snapshot"])
                expected = _read_json(f"{base}.expected.json")
                self.assertEqual(actual, expected)


if __name__ == "__main__":
    unittest.main()
