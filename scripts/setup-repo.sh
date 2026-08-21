#!/usr/bin/env bash
#
# Applies the GitHub repository settings that no commit can set: the About box,
# merge behaviour, private vulnerability reporting, and the ruleset protecting
# the default branch.
#
# Idempotent — safe to re-run. The ruleset is updated in place if one with the
# same name already exists, rather than creating a duplicate.
#
# Requires `gh` (https://cli.github.com) and `gh auth login` with admin rights
# on the repository.
#
#   scripts/setup-repo.sh --dry-run     # print every call, execute none
#   scripts/setup-repo.sh
#   scripts/setup-repo.sh --homepage https://www.npmjs.com/package/jira-alerts-mcp

set -euo pipefail

REPO="rrvrs/jira-alerts-mcp"
RULESET_FILE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/.github/rulesets/main.json"

DESCRIPTION="MCP server for Jira Service Management Operations — alerts, on-call schedules and responders"
TOPICS=(
  mcp model-context-protocol mcp-server
  jira jira-service-management jsm opsgenie atlassian
  alerts on-call incident-response
  typescript claude devops
)

DRY_RUN=false
HOMEPAGE=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run)  DRY_RUN=true; shift ;;
    --homepage) HOMEPAGE="${2:?--homepage needs a URL}"; shift 2 ;;
    --repo)     REPO="${2:?--repo needs owner/name}"; shift 2 ;;
    -h|--help)  sed -n '2,20p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *)          echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

say()  { printf '\n\033[1m%s\033[0m\n' "$*"; }
note() { printf '  %s\n' "$*"; }

# Prints the call in dry-run mode, runs it otherwise.
run() {
  if $DRY_RUN; then
    printf '  [dry-run] gh %s\n' "$*"
  else
    gh "$@" >/dev/null
  fi
}

if ! command -v gh >/dev/null 2>&1; then
  echo "gh is not installed. See https://cli.github.com" >&2
  exit 1
fi

if ! $DRY_RUN && ! gh auth status >/dev/null 2>&1; then
  echo "gh is not authenticated. Run: gh auth login" >&2
  exit 1
fi

[[ -f "$RULESET_FILE" ]] || { echo "missing $RULESET_FILE" >&2; exit 1; }

# ---------------------------------------------------------------- About box --

say "About"
note "description, topics${HOMEPAGE:+, homepage}"

repo_fields=(-X PATCH "repos/$REPO" -f "description=$DESCRIPTION")
[[ -n "$HOMEPAGE" ]] && repo_fields+=(-f "homepage=$HOMEPAGE")

# Unused surfaces off; squash-only so main keeps one commit per PR.
repo_fields+=(
  -F has_wiki=false
  -F has_projects=false
  -F delete_branch_on_merge=true
  -F allow_squash_merge=true
  -F allow_merge_commit=false
  -F allow_rebase_merge=false
  -F allow_auto_merge=true
)

run api "${repo_fields[@]}"

topic_args=(-X PUT "repos/$REPO/topics" -H "Accept: application/vnd.github+json")
for topic in "${TOPICS[@]}"; do topic_args+=(-f "names[]=$topic"); done
run api "${topic_args[@]}"

# ------------------------------------------- Private vulnerability reporting --

say "Private vulnerability reporting"
note "without this, the /security/advisories/new link in SECURITY.md 404s for"
note "anyone who is not a collaborator — which is everyone it is written for"
run api -X PUT "repos/$REPO/private-vulnerability-reporting"

# ------------------------------------------------------------------ Ruleset --

say "Branch ruleset for the default branch"

ruleset_name=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["name"])' "$RULESET_FILE")

existing=""
if ! $DRY_RUN; then
  existing=$(gh api "repos/$REPO/rulesets" --jq \
    ".[] | select(.name == \"$ruleset_name\") | .id" 2>/dev/null || true)
fi

if [[ -n "$existing" ]]; then
  note "updating existing ruleset #$existing"
  run api -X PUT "repos/$REPO/rulesets/$existing" --input "$RULESET_FILE"
else
  note "creating ruleset '$ruleset_name'"
  note "admins keep bypass — see the bypass_actors note in CONTRIBUTING.md"
  run api -X POST "repos/$REPO/rulesets" --input "$RULESET_FILE"
fi

# ------------------------------------------------------------------- Report --

if $DRY_RUN; then
  say "Dry run — nothing was changed."
  exit 0
fi

say "Done. Current state:"
gh api "repos/$REPO" --jq '"  description: \(.description // "—")
  homepage:    \(.homepage // "—")
  topics:      \(.topics | join(", "))
  wiki/projects: \(.has_wiki)/\(.has_projects)
  squash-only: \(.allow_squash_merge and (.allow_merge_commit | not))"'
gh api "repos/$REPO/rulesets" --jq '"  rulesets:    \(length) — \(map(.name) | join(", "))"'

cat <<'NEXT'

  The API response does not prove the required checks were named correctly.
  To be sure, open a throwaway PR and confirm it stays blocked until
  "Node 22" and "Node 24" report green.
NEXT
