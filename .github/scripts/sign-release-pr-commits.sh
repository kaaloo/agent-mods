#!/usr/bin/env bash
# Re-signs the commits release-please pushes onto its release branches, so the
# release PR satisfies the required-signatures ruleset once merged.
#
# Appelé par .github/workflows/release-please.yml. Ne réécrit qu'un commit par
# branche : celui que release-please vient de créer au-dessus de GITHUB_SHA.
# Toute autre forme d'historique est refusée.
#
# Lit dans l'environnement : GIT_SIGNING_KEY et PRS (la sortie JSON
# `prs` de l'action release-please). GITHUB_SHA identifie le commit de main
# attendu comme parent.
#
# Ce script manipule une clé privée : il est isolé dans un fichier pour que
# toute modification du chemin de signature soit visible en revue, et non
# enfouie dans un bloc YAML.
set -euo pipefail
if [[ -z "$GIT_SIGNING_KEY" ]]; then
  echo "GIT_SIGNING_KEY is required to sign the release commit" >&2
  exit 1
fi

# Never hardcode the release branch. release-please derives it from
# the repo shape: with several packages the branches are grouped
# (release-please--branches--main), but with a single package it
# switches to per-component names
# (release-please--branches--main--components--<name>). Read the
# branch the action actually opened instead, one entry per component.
branches="$(printf '%s' "$PRS" | jq -r '.[].headBranchName')"
if [[ -z "$branches" ]]; then
  echo "release-please reported PRs but returned no headBranchName in \$PRS" >&2
  printf 'PRS=%s\n' "$PRS" >&2
  exit 1
fi
printf 'Signing %d release branch(es):\n%s\n' \
  "$(printf '%s\n' "$branches" | wc -l)" "$branches"

signing_key="$RUNNER_TEMP/release-signing-key"
allowed_signers="$RUNNER_TEMP/release-allowed-signers"
trap 'rm -f "$signing_key" "$signing_key.pub" "$allowed_signers"' EXIT
umask 077
if [[ "$GIT_SIGNING_KEY" == *"-----BEGIN"* ]]; then
  printf '%s\n' "$GIT_SIGNING_KEY" > "$signing_key"
else
  printf '%s' "$GIT_SIGNING_KEY" | tr -d '\n' | base64 --decode > "$signing_key"
  printf '\n' >> "$signing_key"
fi
ssh-keygen -y -f "$signing_key" > "$signing_key.pub"

signing_email="luis.arias@numerique.gouv.fr"
git config user.name "Luis Arias"
git config user.email "$signing_email"
git config gpg.format ssh
git config user.signingkey "$signing_key"
git config commit.gpgsign true
git config gpg.ssh.allowedSignersFile "$allowed_signers"
printf '%s %s\n' "$signing_email" "$(< "$signing_key.pub")" > "$allowed_signers"

while IFS= read -r release_branch; do
  [[ -n "$release_branch" ]] || continue
  echo "::group::Sign $release_branch"

  git fetch origin "+refs/heads/$release_branch:refs/remotes/origin/$release_branch"
  git checkout --detach "origin/$release_branch"

  # Release-please must have produced exactly one new commit on top of
  # the main commit that triggered this run. Never rewrite other history.
  if [[ "$(git show -s --format=%P HEAD)" != "$GITHUB_SHA" ]]; then
    echo "Refusing to sign $release_branch: release commit is not a single commit on $GITHUB_SHA" >&2
    exit 1
  fi

  original_commit="$(git rev-parse HEAD)"
  git commit --amend --no-edit
  git verify-commit HEAD
  git push --force-with-lease="refs/heads/$release_branch:$original_commit" origin "HEAD:refs/heads/$release_branch"
  echo "::endgroup::"
done <<< "$branches"
