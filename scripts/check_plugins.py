"""Deterministic checks a change must pass before it is merged.

Run from the repo root: `python3 scripts/check_plugins.py [--base origin/main] [--root <checkout>]`.
It also checks uncommitted and untracked plugin files, so it can run before a commit.
When `--base` cannot be resolved, as in a repo with no commits or no remote, every plugin
is checked.

Repo-wide, every run:
  - every plugin directory, `marketplace.json` entry and `readme.md` Available
    Plugins row agree on name, version, description and location
  - every plugin has a README.md
  - `claude plugin validate .` accepts the marketplace manifest

For each plugin changed since `--base` (every plugin when `--base` cannot be resolved):
  - `claude plugin validate plugins/<name>` passes
  - a mod (a plugin whose hooks/hooks.json names `modules`) passes
    `claude plugin test` when it has tests, and its README's `## Capabilities`
    section names every sensitive noun (`$.process`, `$.fs`, `$.http`, `$.env`)
    the module calls

Exits 1 listing every failure, 0 when all checks pass.
"""

import argparse
import json
import re
import subprocess
import sys
from pathlib import Path

SENSITIVE_NOUNS = ("$.process", "$.fs", "$.http", "$.env")
README_ROW = re.compile(r"^\|\s*\[`([^`]+)`\]\(([^)]+)\)\s*\|\s*(.*?)\s*\|\s*$")


def run(cmd, cwd):
    """Runs a command, returning its exit code and combined output."""
    proc = subprocess.run(cmd, cwd=cwd, capture_output=True, text=True)
    return proc.returncode, proc.stdout + proc.stderr


def load_plugins(root):
    """Maps each plugin name to its directory and parsed plugin.json."""
    plugins = {}
    for manifest in sorted((root / "plugins").glob("*/.claude-plugin/plugin.json")):
        directory = manifest.parent.parent
        plugins[directory.name] = (directory, json.loads(manifest.read_text()))
    return plugins


def readme_rows(text):
    """Maps each plugin name in the readme's tables to its (link, description)."""
    rows = {}
    for line in text.splitlines():
        match = README_ROW.match(line)
        if match:
            rows[match.group(1)] = (match.group(2), match.group(3))
    return rows


def sync_errors(root):
    """Lists every disagreement between plugins/, marketplace.json and readme.md."""
    errors = []
    plugins = load_plugins(root)
    marketplace = json.loads((root / ".claude-plugin" / "marketplace.json").read_text())
    entries = {entry["name"]: entry for entry in marketplace["plugins"]}
    rows = readme_rows((root / "readme.md").read_text())

    for name, (directory, manifest) in plugins.items():
        if manifest.get("name") != name:
            errors.append(f"plugins/{name}: plugin.json name is {manifest.get('name')!r}, not the directory name")
        if not (directory / "README.md").is_file():
            errors.append(f"plugins/{name}: no README.md")
        entry = entries.get(name)
        if entry is None:
            errors.append(f"plugins/{name}: not listed in marketplace.json")
            continue
        if entry.get("source") != f"./plugins/{name}":
            errors.append(f"marketplace.json {name}: source is {entry.get('source')!r}, expected './plugins/{name}'")
        for field in ("version", "description"):
            if entry.get(field) != manifest.get(field):
                errors.append(f"marketplace.json {name}: {field} differs from plugin.json")

    for name, entry in entries.items():
        if name not in plugins:
            errors.append(f"marketplace.json {name}: no plugins/{name}/.claude-plugin/plugin.json")
        row = rows.get(name)
        if row is None:
            errors.append(f"readme.md: no Available Plugins row for {name}")
            continue
        link, description = row
        if link != f"plugins/{name}/README.md":
            errors.append(f"readme.md {name}: links {link!r}, expected 'plugins/{name}/README.md'")
        if description != entry.get("description"):
            errors.append(f"readme.md {name}: description differs from marketplace.json")

    for name in rows:
        if name not in entries:
            errors.append(f"readme.md: row for {name}, which marketplace.json does not list")
    return errors


def git(root, *args):
    """Runs a git command in `root`, returning its stdout; exits on failure."""
    proc = subprocess.run(["git", *args], cwd=root, capture_output=True, text=True)
    if proc.returncode != 0:
        raise SystemExit(f"git {' '.join(args)} failed:\n{proc.stderr}")
    return proc.stdout


def changed_plugins(root, base):
    """Names the existing plugins with files changed since the merge base with `base`.

    Compares the merge base with the working tree and adds untracked files, so
    committed, staged, unstaged and new files all count. Names every plugin when
    the merge base cannot be found.
    """
    proc = subprocess.run(["git", "merge-base", base, "HEAD"], cwd=root, capture_output=True, text=True)
    if proc.returncode != 0:
        print(f"notice: cannot resolve the merge base with {base}; checking every plugin")
        return sorted(load_plugins(root))
    merge_base = proc.stdout.strip()
    paths = git(root, "diff", "--name-only", merge_base).splitlines()
    paths += git(root, "ls-files", "--others", "--exclude-standard").splitlines()
    names = {Path(path).parts[1] for path in paths if path.startswith("plugins/") and len(Path(path).parts) > 2}
    return sorted(name for name in names if (root / "plugins" / name / ".claude-plugin" / "plugin.json").is_file())


def is_mod(directory):
    """True when the plugin's hooks/hooks.json names a hooks module."""
    hooks = directory / "hooks" / "hooks.json"
    return hooks.is_file() and "modules" in json.loads(hooks.read_text())


def capabilities_section(readme_text):
    """Returns the text under the README's `## Capabilities` heading, or None."""
    match = re.search(r"^## Capabilities\s*$(.*?)(?=^## |\Z)", readme_text, re.MULTILINE | re.DOTALL)
    return match.group(1) if match else None


def capability_errors(name, validate_output, readme_text):
    """Lists the sensitive nouns the module calls that the README does not disclose.

    Fails closed: `claude plugin validate` prints a `calls:` line for every
    module (`calls: nothing on $` when it calls nothing), so a missing line
    means the output changed shape and the check cannot be trusted.
    """
    lines = [line.split("calls:", 1)[1] for line in validate_output.splitlines() if " calls:" in line]
    if not lines:
        return [f"plugins/{name}: no 'calls:' line in claude plugin validate output; cannot check Capabilities"]
    calls = " ".join(lines)
    used = [noun for noun in SENSITIVE_NOUNS if f"{noun}." in calls]
    if not used:
        return []
    section = capabilities_section(readme_text)
    if section is None:
        return [f"plugins/{name}: calls {', '.join(used)} but README.md has no '## Capabilities' section"]
    return [f"plugins/{name}: calls {noun} but README.md '## Capabilities' does not mention it" for noun in used if noun not in section]


def has_tests(directory):
    """True when the plugin has any *.test.ts or *.test.tsx file."""
    return any(directory.rglob("*.test.ts")) or any(directory.rglob("*.test.tsx"))


def tail(text, lines=40):
    """The last `lines` lines of `text`, for quoting a command's failure."""
    return "\n".join(text.rstrip().splitlines()[-lines:])


def main():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--base", default="origin/main", help="git ref the change merges into")
    parser.add_argument("--root", type=Path, default=Path(__file__).resolve().parent.parent, help="checkout to check")
    args = parser.parse_args()
    root = args.root.resolve()

    errors = sync_errors(root)

    code, out = run(["claude", "plugin", "validate", "."], root)
    if code != 0:
        errors.append(f"claude plugin validate . failed:\n{out}")

    for name in changed_plugins(root, args.base):
        directory = root / "plugins" / name
        print(f"checking plugins/{name}")
        code, out = run(["claude", "plugin", "validate", f"plugins/{name}"], root)
        print(out)
        if code != 0:
            errors.append(f"claude plugin validate plugins/{name} failed:\n{tail(out)}")
            continue
        if not is_mod(directory):
            continue
        readme = directory / "README.md"
        errors += capability_errors(name, out, readme.read_text() if readme.is_file() else "")
        if not has_tests(directory):
            print(f"notice: plugins/{name} is a mod with no tests")
            continue
        code, out = run(["claude", "plugin", "test", f"plugins/{name}"], root)
        print(out)
        if code != 0:
            errors.append(f"claude plugin test plugins/{name} failed:\n{tail(out)}")

    if errors:
        report = f"{len(errors)} check(s) failed:\n" + "\n".join(f"- {error}" for error in errors)
        print(f"\n{report}")
        return 1
    print("\nall plugin checks passed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
