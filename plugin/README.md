<p align="center">
  <img src="https://capsule-render.vercel.app/api?type=waving&color=0:7c3aed,100:06b6d4&height=170&section=header&text=dsh-ciel%20%E5%A4%8F%E5%B0%94&fontSize=52&fontColor=ffffff&animation=fadeIn&desc=ideas%2C%20never%20steps&descSize=20&descAlignY=72" alt="dsh-ciel" />
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/dsh-ciel"><img src="https://img.shields.io/npm/v/dsh-ciel?style=for-the-badge&logo=npm&color=cb3837" alt="npm version"></a>
  <a href="https://www.npmjs.com/package/dsh-ciel"><img src="https://img.shields.io/npm/dm/dsh-ciel?style=for-the-badge&color=2563eb" alt="npm downloads"></a>
  <a href="https://github.com/higekibaka/dsh-ciel/actions/workflows/ci.yml"><img src="https://img.shields.io/github/actions/workflow/status/higekibaka/dsh-ciel/ci.yml?style=for-the-badge&logo=githubactions&logoColor=white&label=ci" alt="ci status"></a>
  <a href="./LICENSE"><img src="https://img.shields.io/badge/license-MIT-22c55e?style=for-the-badge" alt="license: MIT"></a>
</p>

<p align="center"><b>English</b> | <a href="./README.md">中文</a></p>

# dsh-ciel（夏尔 Ciel）

A pre-planning advisor and a convergent critic for
[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH) —
a second, knowledge-rich model that offers directions, prior art, pitfalls,
and verification checklists **before** the main model commits to a plan.
Ideas, never steps. Named after Ciel, the in-head advisor from *That Time I
Got Reincarnated as a Slime*.

The value is not "the advisor is smarter" — it is **distribution diversity**
plus a forced separation of the exploring and executing cognitive roles. By
constraining the advisor to ideas only, understanding and landing the work
stays with the main model. Full argument: [docs/design.md](docs/design.md).

## How it flows

```mermaid
flowchart TD
    U[user request] --> E[main model explores: read / search / run]
    E --> P{planning without consulting?}
    P -->|yes| R[one reminder injected]
    R --> A
    P -->|no| A[ask_advisor · /advise]
    A --> G{{gates: explore-first · follow-up budget}}
    G --> M[advisor model<br>second model · ideas only]
    M --> I[ideas · prior art · pitfalls · verification targets]
    I --> L[main model plans and lands the work itself]
    L --> D[draft reply]
    D -->|annotation review| C[critic model<br>convergent red-lines]
    C --> S[severity annotations anchored onto the draft]
    S --> F[one-click send-back → final reply]
```

The two pipelines are deliberately **role-separated**:

```text
  divergent (pre-plan)                  convergent (post-draft)
  ────────────────────                  ───────────────────────
  advisor pipeline                      critic pipeline
  ask_advisor · /advise                 annotation review
  ideas · prior art · pitfalls          red-lines · severity tiers
  widens the solution space             narrows the risk surface
  directions, never steps               falsifies output, never
                                        the author's reasoning
```

## What you get

- **`ask_advisor` tool** — one synchronous consultation with the advisor
  model, gated by an explore-first protocol and a bounded follow-up budget.
- **Guidance prompt section** — the consultation protocol injected into the
  system prompt (toggleable).
- **Annotation review (批注评审)** — a per-reply button that runs the
  convergent critic (default `google/gemini-3.7-flash`) over the draft and
  anchors red-line annotations onto the reply text, with severity
  underlines, badges, and a full review panel. Reviews persist across
  restarts.
- **`/advise` command** — human-triggered consultation with auto-assembled
  context; the result card is shown inline and the main model is notified
  automatically.
- **Settings card** — Settings → Plugins → 插件配置 → 夏尔 Ciel, hot-applied
  without restart.

<p align="center">
  <img src="https://github.com/higekibaka/dsh-ciel/raw/main/docs/images/ciel-card-demo.gif" width="640" alt="Settings card interaction: grouped folding, nested groups, catalog dropdowns">
</p>
<p align="center">
  <img src="https://github.com/higekibaka/dsh-ciel/raw/main/docs/images/advise-card.png" width="560" alt="Structured advisor card: tiered items with framing, pitfalls and verification targets">
</p>
<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://github.com/higekibaka/dsh-ciel/raw/main/docs/images/ciel-card-groups-dark.png">
    <img src="https://github.com/higekibaka/dsh-ciel/raw/main/docs/images/ciel-card-groups-light.png" width="47%" alt="Settings card folded into groups, each summarizing its current route">
  </picture>
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://github.com/higekibaka/dsh-ciel/raw/main/docs/images/ciel-card-critic-dark.png">
    <img src="https://github.com/higekibaka/dsh-ciel/raw/main/docs/images/ciel-card-critic-light.png" width="47%" alt="Critic group expanded: provider/model dropdowns fed by the live model catalog">
  </picture>
</p>

## Install

```sh
dsh plugin --profile web add dsh-ciel
```

Restart DSH. The plugin activates globally: the `ask_advisor` tool and the
guidance section reach every agent in every preset; the settings card
appears under **Settings → Plugins → 插件配置**.

> Upgrading from `dsh-advisor` (≤ 0.10.x)? Your `advisor:` section in
> `settings.yaml` is copied into the new `ciel` namespace automatically on
> first boot. The legacy section is left in place — remove it by hand
> whenever you like.

## Configuration

All fields live in the `ciel` settings namespace (the settings card or the
`ciel:` section of `settings.yaml`):

| Field | Default | Description |
|---|---|---|
| `provider` | `kimi-coding` | Advisor provider route (must be registered under Settings → Models) |
| `model` | `kimi-for-coding` | Advisor model id; cross-family diversity pays most |
| `reasoningEffort` | `provider` | Thinking depth pinned onto each advisor request; `provider` follows the provider default |
| `maxTokens` | `4096` | Advisor reply length cap (256–32768) |
| `maxCallsPerTurn` | `3` | Consultations per turn: 1 divergence + follow-up budget |
| `requireExploration` | `true` | First consultation requires a prior non-advisor tool call |
| `enforceFollowupGap` | `true` | Follow-ups require independent work in between |
| `planReminderEnabled` | `true` | One reminder when planning starts unconsulted |
| `guidanceEnabled` | `true` | Inject the consultation protocol into the system prompt |
| `criticProvider` | `google` | Critic provider route (independent of the advisor pipeline) |
| `criticModel` | `gemini-3.7-flash` | Critic model id |
| `criticEffort` | `medium` | Thinking depth pinned onto critic requests; `provider` also accepted |

## Compatibility

- DSH **≥ 0.1.0-rc.7** (keyed `settings.plugin.item` slot); developed and
  verified against **0.1.2-alpha.1**.
- Node.js ≥ 22.
- Designed to coexist with [omdsh-dev/dsh-advisor](https://github.com/omdsh-dev/dsh-advisor):
  the settings namespace moved to `ciel` in 0.11.0 so both plugins can be
  installed side by side.

## Development

```sh
# install the checkout into a throwaway profile (never the main GUI's):
dsh plugin --profile advisor-test add /path/to/dsh-ciel/plugin
pnpm dsh --profile advisor-test --patch /path/to/dsh-ciel/scripts/dev-instance.patch.yml
# open http://127.0.0.1:3180 → Settings → Plugins
```

Run the unit tests with `node --test` inside `plugin/`.

> After a local `pnpm install` inside `plugin/`, run
> `scripts/relink-dev.sh` once: the two `@deepseek-ai/*` devDependencies
> (cordis, typert-protocol) must stay symlinked to the profile's shared
> copies — a real second copy carries its own registry state and breaks the
> linked plugin. npm-installed deployments are unaffected (devDependencies
> are never installed for consumers).

## License

[MIT](./LICENSE) © hgk
