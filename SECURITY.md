# Publication and credential safety

<!-- ciel-doc: current -->

## Public repository scope

Keep runtime source, package metadata and license, CI/release definitions, portable development scripts, regression tests, user documentation and curated verification summaries. Tests are part of reproducibility, not disposable build output.

The following stay local and are excluded by `.gitignore`:

- Raw A/B reports, transcripts, logs, session exports and browser authentication state.
- Historical prototypes, internal planning notes and upstream discussion drafts.
- Browser screenshots and recordings, including cropped images with workspace/session backgrounds. Public illustrations must use synthetic data and receive a separate privacy review.
- Environment files, common credential/private-key files, caches and generated package archives.

Local-only files that were previously tracked must also be removed from Git's index with `git rm --cached`; ignoring a tracked file alone does not exclude it. Removing a file in a new commit does **not** erase it from earlier commits, tags, forks or cached copies.

## Credentials

Never commit API keys, GitHub/npm tokens, private keys, cookies or URLs containing authentication material. Examples should use environment-variable names or clearly fake placeholders, not usable credentials. Review `.env.example` and `.env.sample` too: their names do not make their contents safe.

Ciel's release workflow uses npm Trusted Publishing (OIDC); no long-lived npm token is needed in repository files. Advisor/critic credentials belong in the harness's provider configuration. Jev credentials use Ciel's native secret setting (or TYPESAFE_API_KEY for the default official endpoint), never source or test reports. The password draft is sent to the Host only on explicit Save; settings reads redact value/base/user and expose only whether a key exists. Local settings storage is not an encrypted vault.

## Record store and evidence data

Ciel 0.16.0 and newer write additional versioned records under
`$DSH_HOME/ciel/v1/<kind>/<sessionId>/<hash(id)>.json`; it does not migrate
or read the legacy `$DSH_HOME/dsh-advisor/` JSONL history. The store creates
directories 0700 and files 0600, writes through a random `wx` temp file plus
atomic rename, caps one record at 512 KiB and one session list at 200 records
/ 16 MiB, refuses symlinked directories/files and hard links, and checks file
size and identity before and after a bounded read. There is no arbitrary file
RPC.

Stored evidence is limited to snippets the host actually captured from the
review snapshot: 16 KiB / 200 lines per record and 128 KiB / 128 records per
review by default. New `a1`-style `tool-output/session-tool` receipts preserve bounded, screened original text from allowed turn-local tools; legacy `reported/author-tool` entries remain empty source markers and are not backfilled. Historical Host facts and shallow directory metadata have explicit provenance, not independent replay guarantees. The `contentSha256` field is a consistency check,
not tamper-proofing and not a truth guarantee. Sensitive-content screening
runs before the model input and again before storage, but it is heuristic and
cannot prove that a permitted source contains no secret. The native sidebar
opens historical evidence only through the committed review's evidence ids and
never falls back to the current file. See [docs/read-isolation.md](docs/read-isolation.md).

DSH native session persistence is separate: advisor/reviewer child-session prompts and tool results can remain in the host session store, including reads not selected for the Ciel archive. The Ciel limits and cleanup do not bound or erase those logs. This plugin does not promise trace-free execution or change host retention policy.

## Time-only review budget

Since 0.17.0, query and model-request counts are telemetry, not stopping limits. One total deadline covers capture and all review phases; expiry stops work without an extra model or automatic extension. Scope restrictions, sensitive-input screening, single-response size protection, bounded corpus/evidence capture and storage checks remain active. This does not make the filesystem unrestricted or place a fixed ceiling on monetary cost. Advisor quotas are unchanged (the advisor stays tool-free).

## Restricted PTC review runtime

Since 0.18.0 the tooled verification phase presents only the native reserved
`run_code`. Critic programs execute in Ciel's private worker-hosted QuickJS/WASM
runtime, not DSH's stock worker code runtime: the stock runtime is
bash-equivalent on this host — it can read the whole filesystem and spawn
processes, which would bypass the corpus. The guest
has no ambient Node globals and reaches the host only through async bindings
declared as `read` / `grep` / `glob`, each returning a JSON string the program
must `JSON.parse`. The host routes only the review child's outer `run_code`
through a scoped `tools/execute` hook to a private official PTC definition; the
root `codeRuntime` is never swapped, DSH source is not modified, and missing
capabilities fail the tooled phase closed without an unrestricted fallback.
The private registry keeps DSH's nested scheduling and log format, with Ciel's
own guard owning scope and deadline; isolated private `tools/result` events do
not reach root observers, so not every global policy plugin applies to the
review child. Cancellation and deadline expiry hard-terminate the worker and
drain nested dispatches.

The program receives original source pages separately from bounded archival
receipts (`evidence_spans` / `evidence_limited`); pagination and
`capture_evidence:false` exploration do not consume or silently empty original
read content. The model context receives only what the program prints or returns. A program read is not the same as the model seeing
every file. Native DSH child-session logs may still retain every nested query
beyond the Ciel archive, so Ciel's snippet/record bounds are not a global
trace-free promise. This runtime is a containment boundary for a restricted
review child, not a general sandbox, and this document makes no absolute
security claim. Short or default-credential shapes remain a pre-existing
weakness of the heuristic sensitive-content check.

## Optional Jev data egress

Both Jev switches default off. Review checks send exact claims and cited evidence; advisor checks send the supplied question, context and complete suggestions. The configured HTTPS endpoint receives this content and the explicitly configured key. Only the exact default official endpoint may fall back to TYPESAFE_API_KEY. URLs with credentials, query parameters or fragments, plain HTTP and redirects are rejected. Custom endpoints must be trusted and implement the TypeSafe systemone protocol. This is not a general network-isolation or SSRF guarantee. Results do not rewrite the main verdict or independently verify the supplied background.

## Pre-push review

Before pushing, review both staged content and the complete outgoing history. Run the repository and package checks (also enforced in CI and before future releases):

```sh
pnpm check:docs
node scripts/check-publication.mjs --include-untracked
node scripts/check-publication.mjs --package
```

These checks reject private artifact paths, unreviewed media, personal home paths and common credential shapes. The default inspects tracked files; --include-untracked also checks non-ignored candidates. --package checks the actual npm pack file list; they do not prove the absence of arbitrary secrets or inspect Git history. The only credential-shaped exceptions are exact, deliberately fake values in named security tests. Do not exempt entire test directories.

For a complete outgoing-history review, if Gitleaks is available locally:

```sh
gitleaks git --log-opts="--all" --redact=100 .
gitleaks dir --redact=100 .
git diff --cached --stat
git ls-files -ci --exclude-standard
(cd plugin && npm pack --dry-run --ignore-scripts)
```

The ignored-but-tracked listing should be empty. Inspect the package file list against `plugin/package.json`'s explicit `files` allowlist and npm's automatically included metadata. The 0.20.0 release had 30 files; use the live pack file list rather than treating this historical count as a permanent invariant. Runtime modules, the bundled client, default patch, README and license are intentional; source fixtures, local records and browser captures are not shipped. `plugin/client.js` is generated from `plugin/src/client.js` + `plugin/src/sidebar.js` by `scripts/build-client.mjs`.

History sanitization changes commit and tag object ids. Existing npm artifacts and their original provenance remain unchanged; do not overwrite or republish an existing package version to make its provenance refer to rewritten history. Keep the old-to-new commit mapping private. Fresh clones must pass a complete history scan before the cleanup is considered verified. Old development clones must not push the removed history back to the server.

Ignore rules are not a secret detector and can be bypassed with force-add. Pattern scanning also cannot prove that every possible credential is absent, and does not comprehensively inspect image pixels or every animation frame. Review screenshots separately. Never post unredacted scanner reports in public issues.

If a real credential has been published, revoke or rotate it first. Then coordinate removal from current files and, if needed, affected history/tags and hosted caches; do not assume a normal deletion or force-push revokes a credential.
