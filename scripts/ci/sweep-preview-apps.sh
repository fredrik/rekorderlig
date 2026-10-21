#!/usr/bin/env bash
# Destroys every rekorderlig-pr-<n> app whose PR is closed or merged. Run by
# preview.yml from both jobs, with FLY_API_TOKEN (org-scoped) and GH_TOKEN set.
#
# The `pull_request: closed` run is the intended teardown and it is not
# reliable: GitHub silently creates no run when it cannot build the merge ref
# — the head branch deleted within seconds of closing (`gh pr close
# --delete-branch`), a PR that conflicts with its base, or a stacked PR
# auto-closed because its base branch was deleted. Five stale apps had piled
# up that way by 2026-10-21, each quietly billing for a suspended machine and
# a volume. The database sweep in the close job already assumes the close
# run can be skipped; this is the same assumption applied to the apps.
#
# Runs on every deploy as well as every close so a quiet stretch with no
# merges still gets swept. A destroy that fails is a warning, not a failure:
# the deploy for one PR must not go red because another PR's teardown raced
# it, and a leftover app is exactly what the next run is for.

set -u

[ -n "${FLY_API_TOKEN:-}" ] || { echo "::warning title=No FLY_API_TOKEN::Skipping the preview app sweep."; exit 0; }

# The listing is the only call that may fail the step: with no list there is
# nothing to sweep and the cause (a bad token, Fly down) wants seeing.
apps=$(flyctl apps list --json | jq -r '.[].Name | select(test("^rekorderlig-pr-[0-9]+$"))') || exit 1

for app in $apps; do
  n=${app##*-}
  state=$(gh pr view "$n" --json state -q .state 2>/dev/null || echo UNKNOWN)
  case "$state" in
    CLOSED|MERGED)
      echo "sweeping $app (PR #$n is $state)"
      flyctl apps destroy "$app" --yes \
        || echo "::warning title=Could not destroy $app::PR #$n is $state; the next sweep tries again."
      ;;
    *)
      echo "keeping $app (PR #$n is $state)"
      ;;
  esac
done
