"""Checks the repo-wide sync rules and the mod capability disclosure in scripts/check_plugins.py.

Run from the repo root: `python3 -m unittest discover tests/check_plugins`.
"""

import importlib.util
import json
import subprocess
import tempfile
import unittest
from pathlib import Path

SCRIPT = Path(__file__).resolve().parents[2] / "scripts" / "check_plugins.py"
spec = importlib.util.spec_from_file_location("check_plugins", SCRIPT)
check_plugins = importlib.util.module_from_spec(spec)
spec.loader.exec_module(check_plugins)

DESCRIPTION = "Does one thing well"


def make_repo(root, plugins, entries, rows):
    """Writes a minimal marketplace: plugin dirs, marketplace.json and a readme table."""
    for name, manifest in plugins.items():
        directory = root / "plugins" / name
        (directory / ".claude-plugin").mkdir(parents=True)
        (directory / ".claude-plugin" / "plugin.json").write_text(json.dumps(manifest))
        (directory / "README.md").write_text(f"# {name}\n")
    (root / ".claude-plugin").mkdir()
    (root / ".claude-plugin" / "marketplace.json").write_text(json.dumps({"name": "test", "plugins": entries}))
    table = "\n".join(f"| [`{name}`]({link}) | {description} |" for name, link, description in rows)
    (root / "readme.md").write_text(f"| Plugin | Description |\n| --- | --- |\n{table}\n")


def plugin(name):
    return {"name": name, "version": "1.0.0", "description": DESCRIPTION}


def entry(name, **overrides):
    return {"name": name, "source": f"./plugins/{name}", "version": "1.0.0", "description": DESCRIPTION, **overrides}


def row(name, description=DESCRIPTION):
    return (name, f"plugins/{name}/README.md", description)


class SyncErrors(unittest.TestCase):
    def errors(self, plugins, entries, rows):
        with tempfile.TemporaryDirectory() as tmp:
            make_repo(Path(tmp), plugins, entries, rows)
            return check_plugins.sync_errors(Path(tmp))

    def test_clean_repo_passes(self):
        self.assertEqual(self.errors({"a": plugin("a")}, [entry("a")], [row("a")]), [])

    def test_plugin_missing_from_marketplace(self):
        errors = self.errors({"a": plugin("a")}, [], [])
        self.assertIn("plugins/a: not listed in marketplace.json", errors)

    def test_marketplace_entry_without_plugin(self):
        errors = self.errors({}, [entry("ghost")], [row("ghost")])
        self.assertIn("marketplace.json ghost: no plugins/ghost/.claude-plugin/plugin.json", errors)

    def test_version_mismatch(self):
        errors = self.errors({"a": plugin("a")}, [entry("a", version="1.1.0")], [row("a")])
        self.assertIn("marketplace.json a: version differs from plugin.json", errors)

    def test_readme_description_mismatch(self):
        errors = self.errors({"a": plugin("a")}, [entry("a")], [row("a", "Something else")])
        self.assertIn("readme.md a: description differs from marketplace.json", errors)

    def test_missing_readme_row(self):
        errors = self.errors({"a": plugin("a")}, [entry("a")], [])
        self.assertIn("readme.md: no Available Plugins row for a", errors)

    def test_orphan_readme_row(self):
        errors = self.errors({"a": plugin("a")}, [entry("a")], [row("a"), row("gone")])
        self.assertIn("readme.md: row for gone, which marketplace.json does not list", errors)


VALIDATE_OUTPUT = """
  ❯ ./register.tsx hooks: session.start
  ❯ ./register.tsx calls: $.fs.read, $.process.run, $.ui.resolve
"""


class CapabilityErrors(unittest.TestCase):
    def test_undisclosed_nouns_fail(self):
        errors = check_plugins.capability_errors("m", VALIDATE_OUTPUT, "# m\n\n## Capabilities\n\n- `$.fs`: reads files\n")
        self.assertEqual(errors, ["plugins/m: calls $.process but README.md '## Capabilities' does not mention it"])

    def test_missing_section_fails(self):
        errors = check_plugins.capability_errors("m", VALIDATE_OUTPUT, "# m\n")
        self.assertEqual(errors, ["plugins/m: calls $.process, $.fs but README.md has no '## Capabilities' section"])

    def test_section_ends_at_next_heading(self):
        readme = "## Capabilities\n\n- `$.fs`\n\n## Usage\n\n`$.process` mentioned elsewhere\n"
        errors = check_plugins.capability_errors("m", VALIDATE_OUTPUT, readme)
        self.assertEqual(errors, ["plugins/m: calls $.process but README.md '## Capabilities' does not mention it"])

    def test_disclosed_nouns_pass(self):
        readme = "## Capabilities\n\n- `$.process`: runs git\n- `$.fs`: reads files\n"
        self.assertEqual(check_plugins.capability_errors("m", VALIDATE_OUTPUT, readme), [])

    def test_no_sensitive_calls_needs_no_section(self):
        output = "  ❯ ./register.tsx calls: $.session.usage, $.state.get, $.ui.resolve\n"
        self.assertEqual(check_plugins.capability_errors("m", output, "# m\n"), [])

    def test_missing_calls_line_fails_closed(self):
        output = "  ❯ ./register.tsx hooks: session.start\n"
        errors = check_plugins.capability_errors("m", output, "# m\n")
        self.assertEqual(errors, ["plugins/m: no 'calls:' line in claude plugin validate output; cannot check Capabilities"])


class ChangedPlugins(unittest.TestCase):
    def test_uncommitted_staged_and_untracked_plugins_count(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)

            def git(*args):
                subprocess.run(["git", *args], cwd=root, check=True, capture_output=True)

            def add_plugin(name):
                (root / "plugins" / name / ".claude-plugin").mkdir(parents=True)
                (root / "plugins" / name / ".claude-plugin" / "plugin.json").write_text("{}")

            git("init", "-q", "-b", "main")
            add_plugin("old")
            git("add", "-A")
            git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "base")
            add_plugin("staged")
            git("add", "plugins/staged")
            add_plugin("untracked")
            (root / "plugins" / "old" / "README.md").write_text("edited")
            git("add", "plugins/old")
            (root / "plugins" / "old" / "README.md").write_text("edited again, unstaged")

            self.assertEqual(check_plugins.changed_plugins(root, "main"), ["old", "staged", "untracked"])

    def test_unresolvable_base_checks_every_plugin(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            for name in ("a", "b"):
                (root / "plugins" / name / ".claude-plugin").mkdir(parents=True)
                (root / "plugins" / name / ".claude-plugin" / "plugin.json").write_text("{}")
            subprocess.run(["git", "init", "-q", "-b", "main"], cwd=root, check=True)

            self.assertEqual(check_plugins.changed_plugins(root, "origin/main"), ["a", "b"])


if __name__ == "__main__":
    unittest.main()
