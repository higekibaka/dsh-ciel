# Publication and credential safety

## Public repository scope

Keep runtime source, package metadata and license, CI/release definitions, portable development scripts, regression tests, user documentation and curated verification summaries. Tests are part of reproducibility, not disposable build output.

The following stay local and are excluded by `.gitignore`:

- Raw A/B reports, transcripts, logs, session exports and browser authentication state.
- Historical prototypes, internal planning notes and upstream discussion drafts.
- Unused screenshots; only the six images referenced by the public READMEs are allowed by default.
- Environment files, common credential/private-key files, caches and generated package archives.

Local-only files that were previously tracked must also be removed from Git's index with `git rm --cached`; ignoring a tracked file alone does not exclude it. Removing a file in a new commit does **not** erase it from earlier commits, tags, forks or cached copies.

## Credentials

Never commit API keys, GitHub/npm tokens, private keys, cookies or URLs containing authentication material. Examples should use environment-variable names or clearly fake placeholders, not usable credentials. Review `.env.example` and `.env.sample` too: their names do not make their contents safe.

Ciel's release workflow uses npm Trusted Publishing (OIDC); no long-lived npm token is needed in repository files. Runtime provider credentials belong in the harness's credential configuration, not in this plugin's source or test reports.

Before pushing, review both staged content and the complete outgoing history. If Gitleaks is available locally:

```sh
gitleaks git --log-opts="--all" --redact=100 .
gitleaks dir --redact=100 .
git diff --cached --stat
git ls-files -ci --exclude-standard
(cd plugin && npm pack --dry-run --ignore-scripts)
```

The ignored-but-tracked listing should be empty. Inspect the package file list: the npm package intentionally contains only `LICENSE`, `README.md`, `index.js`, `client.js`, `cordis.patch.yml` and `package.json`.

Ignore rules are not a secret detector and can be bypassed with force-add. Pattern scanning also cannot prove that every possible credential is absent, and does not comprehensively inspect image pixels or every animation frame. Review screenshots separately. Never post unredacted scanner reports in public issues.

If a real credential has been published, revoke or rotate it first. Then coordinate removal from current files and, if needed, affected history/tags and hosted caches; do not assume a normal deletion or force-push revokes a credential.
