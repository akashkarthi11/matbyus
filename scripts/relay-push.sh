#!/usr/bin/env bash
# Push committed work to GitHub through the karthi-github-relay Vercel project (this laptop cannot
# reach github.com). Only when the owner asks. Usage, from the repo root:
#   scripts/relay-push.sh <branch> "<commit message>" [dry]
# <branch> is claude-dev (the relay refuses main). The branch must already hold what you want on
# GitHub. It sends the files that changed since the last relay push (local ref
# refs/relay/<branch>), as ONE commit, then moves that ref.
#
# The relay secret is read from RELAY_SECRET_FILE (default ~/.wealth-relay/secret.txt, outside the
# repo) and is never printed. matbyus shares the relay deployment and its secret with wealth —
# one Vercel project serves several repositories, each named explicitly in the request
# (scripts/relay-push.mjs sends {repo: 'akashkarthi11/matbyus'}), so the same secret authorises
# this push as long as that repo is listed in the relay's GITHUB_RELAY_REPOS.
set -euo pipefail
BRANCH="${1:?usage: scripts/relay-push.sh <branch> \"<message>\" [dry]}"
MESSAGE="${2:?give a commit message}"
DRY="${3:-}"
SECRET_FILE="${RELAY_SECRET_FILE:-$HOME/.wealth-relay/secret.txt}"
[ -f "$SECRET_FILE" ] || { echo "Relay secret file not found: $SECRET_FILE" >&2; exit 1; }
HEAD_SHA="$(git rev-parse "$BRANCH")"
# git's well-known empty-tree hash, so a first-ever push diffs against "nothing" and every file in
# HEAD comes out as an addition — there is no refs/relay/<branch> yet to diff against instead.
EMPTY_TREE="4b825dc642cb6eb9a060e54bf8d69288fbee4904"
BASE="$(git rev-parse -q --verify "refs/relay/$BRANCH" || echo "$EMPTY_TREE")"
[ "$BASE" = "$HEAD_SHA" ] && { echo "Nothing new on $BRANCH since the last relay push ($BASE)."; exit 0; }
WORK="$(mktemp -d)"; trap 'rm -rf "$WORK"' EXIT
mkdir -p "$WORK/repo" "$WORK/sec" "$WORK/job"
git -c core.autocrlf=false -c core.eol=lf archive "$HEAD_SHA" | tar -x -C "$WORK/repo"          # file contents come from the commit, not the working tree
git diff --no-renames --name-status "$BASE" "$HEAD_SHA" > "$WORK/job/changes.txt"
printf '%s' "$MESSAGE" > "$WORK/job/message.txt"
cp "$SECRET_FILE" "$WORK/sec/secret.txt"
echo "Sending $(wc -l < "$WORK/job/changes.txt") changed files ($BASE..$HEAD_SHA) to $BRANCH"
w() { cygpath -w "$1" 2>/dev/null || echo "$1"; }
# The GitHub commit we last saw. The push stops if GitHub has moved since (someone else pushed or
# merged): pull first.
EXPECT="$(cat "$(git rev-parse --git-common-dir)/relay-remote/matbyus-$BRANCH" 2>/dev/null || true)"
MSYS_NO_PATHCONV=1 docker run --rm -e BRANCH="$BRANCH" -e EXPECT="$EXPECT" \
  -v "$(w "$WORK/repo"):/repo:ro" -v "$(w "$WORK/sec"):/sec:ro" -v "$(w "$WORK/job"):/work:ro" \
  -v "$(w "$(pwd)/scripts/relay-push.mjs"):/relay-push.mjs:ro" node:20-alpine node /relay-push.mjs $DRY | tee "$WORK/out.txt"
if [ "$DRY" != "dry" ]; then
  git update-ref "refs/relay/$BRANCH" "$HEAD_SHA"                       # last local commit sent
  GH_SHA="$(grep -o 'COMMIT [0-9a-f]\{40\}' "$WORK/out.txt" | cut -d' ' -f2 || true)"
  if [ -n "$GH_SHA" ]; then mkdir -p "$(git rev-parse --git-common-dir)/relay-remote"; printf "%s" "$GH_SHA" > "$(git rev-parse --git-common-dir)/relay-remote/matbyus-$BRANCH"; fi
fi
