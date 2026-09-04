# tool-agent-team：agent/created 时序竞态会随机杀死一次性子代理（TEAM_NOT_MEMBER）

> 发布位置：deepseek-ai/deepseek-harness → Discussions → General
> 英文版同目录：upstream-agent-team-race-discussion.md

## 症状

挂载 `@deepseek-ai/dsh-experimental-agent-team-profile` 后，**任何**一次性
`subagents.start('spawn', …)` 子代理（我们的是一个只读评审批评者；同样的
路径也服务无状态的顾问子代理）会**概率性地**在迈出第一步之前死亡。子代理
回合以 `stopReason: "error"` 结束，错误详情：

```
agent "<child-session-id>" is not a member of an active Agent Team
```

卸载 team profile 后，同样的 spawn 恢复稳定。在本地 0.1.3-alpha.1 构建上
复现，spawn 带不带 `toolFilter` 都会触发。

## 根因（据我们排查）

`packages/experimental/agent-team/src/roster.ts` 中，descriptor 发布与
`agent/created` 观察者之间存在竞态：

1. `tool-agent-team` 通过 `agent/created` 上的 `maybeInstall` 按代理安装
   团队工具（`packages/experimental/tool-agent-team/src/index.ts`），
   由 `roster.tryMembership(agent)` 把关。
2. `tryMembership` 调用 `subagentDescriptor(agent)`——它折叠子会话**自身
   后缀**（`snapshotEvents(inheritedEventCount)`）来识别「服务商拥有的
   子代理 descriptor」。
3. 在 `agent/created` 这一刻，descriptor 事件在后缀里**尚不可见**，探针
   返回 false。于是一个父代理存活、但父代理不在团队名册里的一次性
   子代理，落入「隐式 lead」分支，被装上了团队工具和 `team:policy`
   系统提示节。
4. 等 prompt 装配时，该提示节的 `text()` 调用的是**抛错版**
   `roster.membership(agent)`。此时 descriptor 已可见，`tryMembership`
   返回 undefined，`membership()` 抛出 `TEAM_NOT_MEMBER`——整个回合失败。

即：安装器在创建时刻把子代理误判为 Lead，prompt 节在装配时刻身份翻转后
把它杀死。

## 修复方向（建议）

- 把隐式 lead 的判定推迟到 descriptor 保证可见之后（例如在首次工具
  发现 / prompt 装配时分类，而不是 `agent/created`）；或
- 让 `team:policy` 提示节非抛错（用 `tryMembership` 解析，成员身份消失
  时渲染为空），使过期的安装无害化；或
- `maybeInstall` 在 descriptor 出现时复查并卸载。

如需要，我们可以提供复现现场的子会话日志（`session.v2.jsonl.zstd`）。

## 附带诉求：spawnTeammate 的路由桥接

我们在做一个spawn一次性子代理的插件时撞上这个问题。目前的绕行方案是
不挂载 team profile——但这也意味着我们无法试用（本来很有前途的）
teammate 邮箱进展通道：`SpawnTeammateRequest` 不支持按次 pin 模型路由
（其中 `provider` 字段选择的是 subagent 提供方，LLM 路由活在 team 包的
profile 配置层），而底层 continuable descriptor 明明有
`agentProvider/agentModel/agentReasoningEffort` 字段。如果
`SpawnTeammateRequest` 能暴露 agentOptions，我们这边第二个使用场景
（批评者 teammate 化 + 邮箱叙事进展）就能解锁。
