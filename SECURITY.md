# Security and publication

<!-- ciel-doc: current -->

## Advisor boundary

The advisor is tool-free and receives the question and context supplied by its caller. Credential screening is heuristic, not a proof that arbitrary text is secret-free. Do not supply private data that the selected provider must not receive. Requested routes and actual model sources are recorded separately; a requested route is not proof that a model ran.

One consultation creates one tool-free child and has a shared deadline. Provider transport retries are a different layer and may occur before that deadline. Neither the deadline nor the response token cap guarantees a fixed monetary cost. Cancellation cannot refund consumed tokens.

## Stored records

Advice and call-usage records are written under `$DSH_HOME/ciel/v1/<kind>/<sessionId>/<hash(id)>.json`. The store requests POSIX modes 0700 for directories and 0600 for files, uses random exclusive temporary files and atomic rename, and caps a record at 512 KiB. Existing-directory chmod is best-effort; Windows ACLs and platform behavior are not guaranteed by these mode bits. It validates kind/session/id, rejects detected symlinked store directories and hard-linked record files, uses O_NOFOLLOW for record reads where the platform provides it, and checks identity and size around bounded reads. DSH_HOME and its ancestors must be trusted: these checks are not an isolation boundary against a malicious local process concurrently changing paths, and file-symlink refusal is not guaranteed on platforms without O_NOFOLLOW. There is no arbitrary-file RPC or record-listing API.

Old review/evidence/feedback/inbox records are retained inert, not read, migrated or deleted. Legacy `dsh-advisor` JSONL files are not migrated. Native DSH session persistence is separate and may retain advisor prompts and tool results. Ciel makes no trace-free promise and does not change Host retention policy.

## Jev data egress and secrets

Jev is opt-in. It sends the question, provided context and at most six complete original structured advice sections selected for checking to the configured TypeSafe-compatible endpoint. The serialized question/context/selected-items state is capped at 24 KiB; missing or oversized sections are skipped, and suspected sensitive input skips the check. The result does not certify that the entire answer was checked. It checks consistency with supplied context, not independently verified truth. Failure is explicit and keeps the original advice.

Custom endpoints receive the configured key and text and must be trusted. Only the exact default official endpoint may use `TYPESAFE_API_KEY` fallback. HTTPS is mandatory; URLs containing credentials, query parameters or fragments and redirects are rejected. These checks are not a complete SSRF/network-isolation guarantee.

The key draft reaches the Host only on explicit Save. Settings reads redact secret values and expose only configured/unconfigured state; revision checks fence stale writes. Local configuration is not an encrypted vault. Provider credentials belong in DSH's provider configuration, never source, fixtures or logs.

## Publication checks

Keep runtime source, reproducible tests, portable scripts and current docs public. Keep credentials, raw transcripts, browser state, screenshots, model reports and private prototypes local. Removing a tracked file does not erase earlier commits, tags or cached copies.

```sh
pnpm check:docs
node scripts/check-publication.mjs --include-untracked
node scripts/check-publication.mjs --package
```

These checks inspect current candidate files and the actual package file list for private paths and common credential shapes. They do not prove absence of secrets and do not inspect outgoing Git history. Review that history separately before publishing; rotate any exposed credential and report it privately without pasting its value into a public issue. Releases use npm Trusted Publishing rather than a committed long-lived token.
