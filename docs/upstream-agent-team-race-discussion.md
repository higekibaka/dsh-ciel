## Symptom

With `@deepseek-ai/dsh-experimental-agent-team-profile` mounted, **any** one-shot `subagents.start('spawn', …)` child (ours is a read-only review critic; the same path also serves stateless consultant subagents) intermittently dies before its first step. The child turn ends with `stopReason: "error"` and detail:

```
agent "<child-session-id>" is not a member of an active Agent Team
```

Un-mounting the team profile makes the same spawns reliable again. Reproduced on a local 0.1.3-alpha.1 build, with and without a `toolFilter` on the spawn.

## Root cause (as far as we can tell)

A race between descriptor publication and the `agent/created` observer in `packages/experimental/agent-team/src/roster.ts`:

1. `tool-agent-team` installs Team tools per-agent via `maybeInstall` on `agent/created` (`packages/experimental/tool-agent-team/src/index.ts`), gated by `roster.tryMembership(agent)`.
2. `tryMembership` checks `this.subagentDescriptor(agent)`, which folds the child's **own session suffix** (`snapshotEvents(inheritedEventCount)`) for a provider-owned subagent descriptor.
3. At `agent/created` time that descriptor event is not yet visible in the suffix, so the probe returns `false`. The fresh one-shot child — direct child of a live non-Team parent — falls through to the "implicit lead" branch and gets Team tools plus a `team:policy` system-prompt section installed.
4. When the prompt is later assembled, the section's `text()` calls `roster.membership(agent)` (the throwing variant). By then the descriptor **is** visible, `tryMembership` returns `undefined`, and `membership()` throws `TEAM_NOT_MEMBER` — failing the whole turn.

So the installer classifies the child as a Lead at creation time, and the prompt section kills it at assembly time once the classification flips.

## Suggested directions

- Defer the implicit-lead classification until the subagent descriptor is guaranteed visible (e.g. classify on first tool discovery / prompt assembly rather than `agent/created`), or
- Make the `team:policy` prompt section non-throwing (resolve with `tryMembership` and render nothing when membership is gone), so a stale install is harmless, or
- Have `maybeInstall` re-check and uninstall when the descriptor appears.

Happy to provide child session logs (`session.v2.jsonl.zstd`) from a repro if useful. We hit this while building a plugin that spawns one-shot subagents; our current workaround is not mounting the team profile, which also means we can't dogfood the (otherwise very promising) teammate mailbox for progress reporting — `spawnTeammate` doesn't support per-call model-route pins (`provider` in `SpawnTeammateRequest` selects the subagent provider, and the LLM route lives at the team package's profile config level), so per-invocation `provider/model/reasoningEffort` pins from plugin settings can't be honored. A route bridge there would unblock a second use case for us.
