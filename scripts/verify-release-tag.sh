#!/usr/bin/env bash
# verify-release-tag.sh: refuses to deploy a version with no recorded security approval. The
# project's security gate is recorded in each annotated version tag, on a line like:
#   Security review: approved 2026-11-04, report <file>, accepted risks: none
# server/update.sh runs this, so the gate is enforced by tooling rather than by memory.
#
#   scripts/verify-release-tag.sh v1.2.0     # exit code 0 if approved, 1 if not
set -euo pipefail

TAG="${1:?Usage: verify-release-tag.sh <tag>}"

# A lightweight tag is just a pointer and can't carry the approval line, so it's refused.
if [ "$(git cat-file -t "refs/tags/$TAG" 2> /dev/null || true)" != "tag" ]; then
  echo "Refusing $TAG: it isn't an annotated tag, so it has no security approval." >&2
  exit 1
fi

if ! git tag -l --format='%(contents)' "$TAG" | grep -qE '^Security review: approved [0-9]{4}-[0-9]{2}-[0-9]{2},'; then
  echo "Refusing $TAG: its tag has no 'Security review: approved <date>,' line." >&2
  exit 1
fi
echo "$TAG has a recorded security approval."
