#!/usr/bin/env python
from __future__ import annotations
import os, sys, json, datetime, pathlib, textwrap, requests
from openai import OpenAI

REPO = "loophole/loophole"
CACHE_FILE = pathlib.Path(".github/triage_cache.json")
STAMP_FILE = pathlib.Path(".github/last_triage.txt")

THEMES_MD = textwrap.dedent("""\
1. LLM Integration and Provider Support
2. App Build and Platform Compatibility
3. Prompt, Token, and Cost Management
4. Editor UX and Interaction Design
5. Agent and Automation Features
6. System Config and Environment Setup
7. Meta: Feature Comparison, Structure, and Naming
""").strip()

client  = OpenAI(api_key=os.environ["OPENAI_API_KEY"])
headers = {"Authorization": f"Bearer {os.environ['GITHUB_TOKEN']}"}


# ───────── helpers ────────────────────────────────────────────────────────
def utc_iso_now() -> str:
    return datetime.datetime.utcnow().replace(microsecond=0, tzinfo=datetime.timezone.utc).isoformat()

def read_stamp() -> str:
    return STAMP_FILE.read_text().strip() if STAMP_FILE.exists() else "1970-01-01T00:00:00Z"

def save_stamp():
    STAMP_FILE.parent.mkdir(parents=True, exist_ok=True)
    STAMP_FILE.write_text(utc_iso_now())

def load_cache() -> dict[int, str]:
    return json.loads(CACHE_FILE.read_text()) if CACHE_FILE.exists() else {}

def save_cache(d: dict[int, str]):
    CACHE_FILE.parent.mkdir(parents=True, exist_ok=True)
    CACHE_FILE.write_text(json.dumps(d, indent=2))

def fetch_open_issues(since_iso: str | None = None) -> list[dict]:
    issues, page = [], 1
    while True:
        url = (
            f"https://api.github.com/repos/{REPO}/issues"
            f"?state=open&per_page=100&page={page}"
            + (f"&since={since_iso}" if since_iso else "")
        )
        chunk = requests.get(url, headers=headers).json()
        if not chunk or (isinstance(chunk, dict) and chunk.get("message")):
            break
        issues.extend(i for i in chunk if "pull_request" not in i)
        page += 1
    return issues


# ───────── main ───────────────────────────────────────────────────────────
last_stamp = read_stamp()
changed    = fetch_open_issues(since_iso=last_stamp)

# Fallback if **nothing** changed AND we have *no* existing output
if not changed:
    cache_exists = CACHE_FILE.exists()
    wiki_exists  = pathlib.Path("wiki/Issue-Categories.md").exists()
    if not cache_exists or not wiki_exists:
        # first run or someone wiped the wiki → build from scratch
        print("⏩ First run or empty wiki — fetching ALL open issues.", file=sys.stderr)
        changed = fetch_open_issues()         # full list
    else:
        print(f"✅ No issues updated since {last_stamp}. Nothing to classify.", file=sys.stderr)
        save_stamp()
        sys.exit(0)

# ---------------------------------------------------------------- prompt
issue_lines = "\n".join(f"- {i['title']} ({i['html_url']})" for i in changed)
prompt = textwrap.dedent(f"""\
You are an AI assistant helping triage GitHub issues into exactly 7 predefined themes.

Each issue must go into exactly one of the themes below:

{THEMES_MD}

Format your output in Markdown like:
## Prompt, Token, and Cost Management
- [#123](https://github.com/org/repo/issues/123) – Title here

Classify these issues:
{issue_lines}
""")

resp = client.chat.completions.create(
    model="gpt-4.1",
    messages=[{"role": "user", "content": prompt}],
    temperature=0.2,
)

md = resp.choices[0].message.content

# ---------------------------------------------------------------- parse GPT
new_map: dict[int, str] = {}
current = None
for ln in md.splitlines():
    if ln.startswith("##"):
        current = ln.lstrip("# ").strip()
    elif ln.lstrip().startswith("- [#"):
        try:
            num = int(ln.split("[#")[1].split("]")[0])
            new_map[num] = current
        except Exception:
            pass  # ignore malformed lines

cache = load_cache()
cache.update(new_map)
save_cache(cache)
save_stamp()

# ---------------------------------------------------------------- rebuild wiki
order = [
    "LLM Integration and Provider Support",
    "App Build and Platform Compatibility",
    "Prompt, Token, and Cost Management",
    "Editor UX and Interaction Design",
    "Agent and Automation Features",
    "System Config and Environment Setup",
    "Meta: Feature Comparison, Structure, and Naming",
]

sections: dict[str, list[int]] = {t: [] for t in order}

# ── fetch ALL current open issues once  (PRs filtered out) ────────────────
title_map: dict[int, tuple[str, str]] = {}
open_now: set[int] = set()

page = 1
while True:
    batch = fetch_open_issues(since_iso=None) if page == 1 else []
    if not batch:
        break
    for it in batch:
        num = it["number"]
        title_map[num] = (it["title"], it["html_url"])
        open_now.add(num)
    page += 1

# 🧹 drop any cached IDs that are no longer open issues (e.g., became a PR or were closed)
for stale in set(cache) - open_now:
    del cache[stale]
save_cache(cache)            # persist cleaned cache

# build sections from cleaned cache
for num, theme in cache.items():
    if theme in sections:          # extra safety
        sections[theme].append(num)

# ---------------------------------------------------------------- print roadmap
for theme in order:
    issues = sections[theme]
    if issues:
        print(f"## {theme}")
        for n in sorted(issues):
            title, url = title_map.get(n, ("(missing)", f"https://github.com/{REPO}/issues/{n}"))
            print(f"- [#{n}]({url}) – {title}")
        print()
