# DeepSeek Harness 记忆插件生态与 MistyMoon Memory 独立开源判断

> 调研日期：2026-08-21（Asia/Shanghai）<br>
> 基线：`69ea9809079007ab0bff6abfa58c8cd3483f8044`<br>
> DSH 版本口径：本仓库仍固定 `0.1.0-rc.7`；DSH 官方已于 2026-08-19 发布 `0.1.0-rc.8`。<br>
> 结论时点：截至 2026-08-21；除非另注，本文所有链接均于 2026-08-21 访问。<br>
> 隐私边界：本次调研没有读取或回显任何私有 Persona、Memory、DSH Home、会话或用户数据。

## 结论摘要

1. **把 Memory 从 MistyMoon 套件拆成独立 DSH 插件仓库是合理方向，但市场定位必须从“又一个长期记忆插件”收窄为“DSH 原生、Owner 治理、来源可追溯、支持人工或定时自动审核的记忆控制面”。** 纯粹的跨会话记忆、自动召回、SQLite/Markdown、本地优先和 WebUI 都已经有强竞争者。
2. **截至本次检索，没有发现公开 DSH 记忆插件完整实现“候选保持隔离 → 用户可逐条/批量人工审核 → 用户指定本地时区的凌晨批处理 → 独立审核 Agent/规则给出可追溯判定 → 失败关闭且可重放”的流程。** `dsh-noema`、`dsh-memento`、`dsh-memory-evolve` 已有候选或人工确认；`dsh-auto-review` 已有通用第二模型即时审批；但尚未发现它们把两者组成记忆专用的、定时批量审核产品。这是机会，不是没有邻近竞品。
3. **最直接的治理竞品是 `dsh-memento` 和 `dsh-noema`，产品广度竞品是 `dsh-mnemon` 和 `dsh-memory-evolve`，检索/规模竞品是 MemOS、Mem0 与 Graph Memory。** `dsh-memento` 已有不可绕过的写审批、来源策略、审计和版本；`dsh-noema` 已有候选队列、accept/reject/edit/merge、敏感度和来源元数据；`dsh-mnemon` 已有三层记忆、九种 Provider、WebUI 和受监督写入。
4. **开源后获得一批 DSH 用户选择是“中等概率、强条件成立时可上调”，但现在不能证据化地预测绝对用户数。** DSH 仍明确处于 developer preview 并警告会有破坏性变更；大多数直接竞品只发布了一周左右。GitHub stars 与 npm downloads 已显示需求，但不等于活跃用户或留存。[DSH 官方 README](https://github.com/deepseek-ai/deepseek-harness/blob/master/README.md)
5. **要达到“较多用户选择”，发布门槛不是功能数量，而是四件事：** 一条命令安装、从 MistyMoon 旧数据无损迁移、默认本地且不依赖 RP、以及公开可复现的治理/召回评测。若仍需要先装 MistyMoon、手工改 patch、或无法解释每条记忆的 Owner/来源/审核决定，胜率会明显下降。
6. **兼容性已经是现实发布风险。** DSH 最新预发布版是 `0.1.0-rc.8`，而本仓库固定 `rc.7`，`dsh-noema` 的 peer 仍指向 `rc.6`，只有已核验的 `dsh-mnemon` 当前 manifest 对齐 `rc.8`。独立仓库首发前必须同时验证“项目基线”和“DSH 最新 release”，不能把能在旧 rc 构建等同于当前可安装。[DSH rc.8 release](https://github.com/deepseek-ai/deepseek-harness/releases/tag/v0.1.0-rc.8) · [DSH 根 manifest](https://github.com/deepseek-ai/deepseek-harness/blob/master/package.json)

## 1. 调研口径与证据等级

### 1.1 什么算 DSH 记忆竞品

本文按四级区分，避免把“通用 agent memory”误写成“DSH 插件”：

- **A：DSH 官方互操作面**：官方仓库提供、但明确是第三方系统示例而非官方记忆产品。
- **B：DSH 原生/明确适配**：仓库含 `cordis.patch.yml` 或 npm manifest 的 `dsh.bundle.patch`，公开 DSH 安装命令，并说明对某个 DSH rc 的测试。
- **C：可作为外部 Provider，尚非独立 DSH 插件**：由 B 类插件适配，或可经官方 MCP 客户端接入。
- **D：通用或其他宿主插件**：功能相关，但没有 DSH bundle/适配证据；不能列为 DSH 直接竞品。

### 1.2 检索范围

检索覆盖：

- DSH 官方仓库 README、扩展 cookbook、配置目录、MCP memory 示例、Discussions；
- GitHub `dsh-plugin` topic 与 `memory` 关键词发现面；
- 候选仓库的 README、`package.json`/manifest、`cordis.patch.yml`、许可证、release/commit/issue 元数据；
- npm registry manifest 与 2026-08-14 至 2026-08-20 下载计数；
- 被用户点名的 `dsh-noema`、Mnemon、Mem0、LivingMemory，以及发现面中采用或差异化信号较强的其他项目。

GitHub 搜索 `topic:dsh-plugin memory` 在调研时返回 285 个仓库，但包含“内存监控”、其他宿主以及仅在 README 提及 memory 的噪声，因此这个数只能当候选发现量，**不能当 DSH 记忆插件总数**。[GitHub Search API](https://api.github.com/search/repositories?q=topic%3Adsh-plugin%20memory&sort=stars&order=desc&per_page=100)

### 1.3 证据限制

- 仓库 README、release 与 manifest 是一手发布证据，但功能陈述通常是项目方自述；本次未逐个安装运行全部竞品。
- stars 表示关注，不表示安装、活跃使用或留存。
- npm downloads 会混入 CI、缓存、开发重装和跨宿主使用；尤其 MemOS local plugin 同时服务多个 agent，不能把其下载全部归因于 DSH。
- DSH 生态极新。官方明确称其处于 developer preview、会发生兼容性破坏，因此一周数据外推到稳定期的误差很大。[DSH 官方 README](https://github.com/deepseek-ai/deepseek-harness/blob/master/README.md)

## 2. DSH 官方立场：有扩展 seam，没有内置长期记忆产品

DSH 官方最新预发布版是 2026-08-19 发布的 `0.1.0-rc.8`，根 manifest 也已同步为 `rc.8`；本 MistyMoon 基线仍固定 `rc.7`，两者必须在兼容矩阵中分开记录。[DSH releases](https://github.com/deepseek-ai/deepseek-harness/releases) · [DSH 根 manifest](https://github.com/deepseek-ai/deepseek-harness/blob/master/package.json)

官方扩展 cookbook 把 Memory 描述为“section provider + tool”，说明记忆应作为插件能力组合，而不是要求修改 Harness 核心；官方 CLI 能识别 package manifest 中的 `dsh.bundle.patch` 并把 bundle 加入 profile layer。[扩展 cookbook](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/cookbook/extension-cookbook.md) · [CLI plugin management](https://github.com/deepseek-ai/deepseek-harness/blob/master/apps/cli/reference/README.md)

官方还提供三组默认关闭的第三方 MCP memory overlay：Memorix 1.3.0、MCP Reference Memory 2026.7.4、Engram 1.20.0。官方明确说明这些只是互操作示例，不表示推荐、背书或持续支持；DSH 只负责 MCP 连接、工具发现和生命周期，Provider 的安装、身份、存储、迁移和许可证仍由 Provider 自己负责。[官方 MCP memory 示例](https://github.com/deepseek-ai/deepseek-harness/blob/master/examples/mcp-memory/README.md)

这带来两个判断：

- **独立 Memory 仓库符合 DSH 的插件架构方向。** 它不应再依赖 MistyMoon Foundation/Persona 才能装载。
- **DSH 官方 MCP 示例会构成免费基线，但不是治理竞品。** MCP Reference Memory 只做本地知识图谱和子串检索，没有自动摘要、冲突解决、遗忘策略或 Owner 审批；这正是独立 MistyMoon Memory 可以补足的层。

官方配置目录还表明，DSH 的用户审批策略只有 `ask | never`；`never` 是 CI/无人值守下确定性拒绝，而不是自动批准。若要实现自动审核后批准，插件必须显式提供 answerer/审核策略，不能把 DSH 的 `never` 当成自动审批。[`@deepseek-ai/dsh-user-approval` 配置](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/config-catalog.md)

## 3. 直接竞争格局

### 3.1 采用与安装信号快照

| 项目 | DSH 关系与安装 | 2026-08-21 可见信号 | 许可证 |
|---|---|---:|---|
| [`dsh-memory-evolve`](https://github.com/csyangwen/dsh-memory-evolve) | B；GitHub bundle，一条 `dsh plugin ... add github:` | 205 stars、14 forks；约 306 commits | MIT |
| [`dsh-mnemon`](https://github.com/omdsh-dev/dsh-mnemon) | B；npm `dsh-mnemon`，另装 Mnemon binary；当前 manifest 对齐 DSH rc.8 | 136 stars、8 forks；npm 0.2.13；8/14–8/20 下载 8,476 | 插件 MIT；Mnemon 引擎 Apache-2.0 |
| [`dsh-noema`](https://github.com/ZSeven-W/dsh-noema) | B；npm `@zseven-w/dsh-noema`，bundle 自带平台 binary | 116 stars、7 forks；npm 8/14–8/20 下载 726 | 插件及其 ZSeven-W/noema 核心均 MIT |
| [`dsh-memento`](https://github.com/PerryLink/dsh-memento) | B；npm/GitHub bundle | 59 stars、1 fork；npm 0.4.2；8/14–8/20 下载 1,292 | Apache-2.0 |
| [`dsh-mneme`](https://github.com/modusensus/dsh-mneme) | B；原生结构化记忆 | 30 stars、3 forks | MIT |
| [MemOS](https://github.com/MemTensor/MemOS) | B/C；官方仓库内有 DSH cloud 与 local adapter | 核心仓库约 10.8k stars；local plugin 下载 1,380，cloud DSH plugin 535 | 核心 Apache-2.0；两款 npm adapter manifest 为 MIT |
| [Graph Memory](https://github.com/adoresever/graph-memory) | B；DSH beta 已实现，但目前从源码打 tgz 安装 | 562 stars、80 forks；其中大量关注早于 DSH adapter，不能全算 DSH 采用 | MIT |
| [Mindspace Session Memory](https://github.com/Spirtxiaoqi7/mindspace-dsh-session-memory) | B；树外 DSH bundle，当前 main 需源码 pack | 3 stars、1 fork | MIT |
| [Nowledge Mem DSH](https://github.com/nowledge-co/nowledge-mem-deepseek-harness) | B/C；DSH bundle + 本地/远端 Nowledge MCP/CLI | 5 stars、1 fork | GitHub API 未识别顶层许可证；复用前必须澄清 |
| [官方 MCP 三例](https://github.com/deepseek-ai/deepseek-harness/blob/master/examples/mcp-memory/README.md) | A/C；手工 overlay + 外部 server | DSH 官方示例背书的是“可连接”，不是产品推荐 | Memorix Apache-2.0；MCP Reference Memory MIT；Engram MIT |

stars/forks 来自各仓库页面与 GitHub repository API；npm 下载来自 npm 官方统计端点：[dsh-mnemon](https://api.npmjs.org/downloads/point/2026-08-14:2026-08-20/dsh-mnemon)、[dsh-noema](https://api.npmjs.org/downloads/point/2026-08-14:2026-08-20/%40zseven-w%2Fdsh-noema)、[dsh-memento](https://api.npmjs.org/downloads/point/2026-08-14:2026-08-20/dsh-memento)、[MemOS local](https://api.npmjs.org/downloads/point/2026-08-14:2026-08-20/%40memtensor%2Fmemos-local-plugin)、[MemOS cloud DSH](https://api.npmjs.org/downloads/point/2026-08-14:2026-08-20/%40memtensor%2Fmemos-cloud-dsh-plugin)。

### 3.2 治理、范围与存储对比

| 项目 | 写入/审批 | Owner、scope、来源 | 召回 | 存储、迁移与隐私 |
|---|---|---|---|---|
| dsh-memory-evolve | 关键记忆声称用户确认后生效；待办有待确认队列；项目/每日日志则每回合自动写 | 用户档案、全局事实、项目/分支、每日轨；README 展示日志与分支来源，但不等同于逐条来源消息 ID | 多轨注入、项目日志/本地搜索 | 本地、零运行时依赖；可用 Git 分支跨设备同步，扩大了误推私密记忆的操作风险面 |
| dsh-mnemon | “Remember”由干净任务 Agent 资格判断、路由、去重和蒸馏，Host 仅在 accepted 时写；手工创建要求用户选空间 | global/workspace/custom；Memory Space 另有 provider namespace；Turn memory 可导航到来源 | Runtime 常驻 + Documents 搜索 + 九 Provider 并发/有界召回 | Runtime/Documents 本地；Mnemon SQLite 本地；外部 Provider 显式 opt-in；换 scope 不自动迁移或删除 |
| dsh-noema | 底层有 pending candidate 与 accept/reject/edit/merge；但 DSH wrapper 默认 `Auto-accept new memories = on`，用户可关闭并用 review 工具/页面 | 底层 tenant/user/project、source metadata、sensitivity；wrapper 还维护导入 ledger | BM25、PageIndex、图扩展、RRF、解释接口；不用 embeddings | Markdown + JSONL + 本地索引；tombstone/hard delete/restore deletion manifest；默认 `~/.agent-memory` |
| dsh-memento | 服务层不可绕过审批；`ask | auto | off`；compaction 只生成 pending proposal；拒绝也留审计 | user/agent track × user-global/workspace × agentPreset；per-source policy；审批与 session log 重建；条目 version | frozen snapshot + substring query + DSH session history recall；无 FTS5 | 本地 SQLite/WAL/0600，schema 版本 loud fail；零网络、零凭据 |
| MemOS | DSH local/cloud 插件自动 recall、后台 capture；公开文档未展示 MistyMoon 式候选人工审批默认链 | memory cube 支持 user/project/agent 隔离与组合；有 feedback/correction | FTS5 + vector、图、异步 ingest、multi-modal | local SQLite 或 cloud/self-host；自托管完整版可需 Neo4j/Qdrant；迁移与部署面较重 |
| Graph Memory | 自动结构化抽取；关键 beta 知识建议 `gm_record`；未见候选审批队列 | TASK/SKILL/EVENT 保留 source session；稳定 event id，图边解释召回 | vector + FTS5 + graph traversal + PageRank；有界子图注入 | 本地 SQLite，embedding 可选；维度/模型变更重嵌入；当前 DSH beta 尚未 npm 发布 |
| Mindspace | 从用户明确陈述保守自动抽取；原子化 next-state 校验；没有全局长期记忆人工审批工作流 | 严格 session-isolated；confirmed facts 与 AI observations 分离；append/merge/replace/skip 记录 source message sequence | 会话级 profile、preference、instruction、relationship/mission 注入 | 事件回放与 V1→V2 迁移；定位是 session personalization，不是跨会话 Owner 档案 |
| Nowledge | turn-end 把用户/assistant/tool-result transcript 自动导入；未见人工候选 gate | `spaceId`、`agentId`、sourceApp/importOrigin；source hints | startup bundle + prompt-time search + MCP tools | 本地 `nmem` 或 cloud；remote 需要 API key；历史 DSH session 尚不回填 |

## 4. 点名项目核查

### 4.1 `dsh-noema`：真正的 DSH 原生竞品，而且底层不是 Fail-Safe/Noema

`dsh-noema` 是明确的 DSH bundle：README 给出 `dsh plugin --profile web add @zseven-w/dsh-noema@latest`，仓库含 `cordis.patch.yml`，npm manifest 声明 bundle patch，测试目标为 DSH `0.1.0-rc.6`。它自带 per-platform 可选 npm binary、设置页、导入十种 coding-agent 记忆、server keep-alive 与完整 MCP 工具面。[dsh-noema README](https://github.com/ZSeven-W/dsh-noema)

容易混淆的事实：该插件 submodule 指向 [`ZSeven-W/noema`](https://github.com/ZSeven-W/noema)，这是 Rust、非向量、候选审核队列的实现；**不是**另一个同名的 Go 项目 [`Fail-Safe/Noema`](https://github.com/Fail-Safe/Noema)。两者都是通用 agent memory，但只有 ZSeven-W/noema 与此 DSH wrapper 有仓库级关系。

优势：

- 默认本地 Markdown/JSONL，可读可删；
- candidate → pending → accept/reject/edit/merge；secret 自动拒绝、personal sensitivity cap、payload-free audit；
- BM25 + PageIndex + graph/RRF，并能解释为什么召回；
- 导入 Codex、Claude Code、Cursor、Hermes 等，对刚迁到 DSH 的用户很有吸引力；
- 已有 DSH 设置页和 npm 平台二进制，安装摩擦低。

弱点/机会：

- wrapper README 的“Auto-accept new memories”默认是 on，治理优先用户必须主动关闭；
- 底层 README 明示 early implementation、格式/接口仍可能变化；
- 未发现按用户时区的夜间批量审核；
- 当前源码的 DSH peer 仍固定 `0.1.0-rc.6`，落后官方最新 `rc.8`；
- **发布信息有不一致**：wrapper README 写“Current plugin release 0.1.0-rc.2”，而 2026-08-21 npm registry 的 `latest` 仍是 0.1.0-rc.1。独立 MistyMoon Memory 若能保持 README、tag、registry、锁文件一致，会形成可信度优势。[npm registry manifest](https://registry.npmjs.org/%40zseven-w%2Fdsh-noema)

许可证：wrapper MIT，ZSeven-W/noema README 也声明 MIT；可参考接口思想，但仍应独立实现并保留归属要求。[dsh-noema LICENSE](https://github.com/ZSeven-W/dsh-noema/blob/main/LICENSE) · [ZSeven-W/noema license statement](https://github.com/ZSeven-W/noema)

### 4.2 Mnemon / `dsh-mnemon`：采用信号最强的 DSH 专用产品之一

Mnemon 引擎是独立的 Apache-2.0 Go binary；其官方 README 明确指向 `dsh-mnemon`，并给出 DSH 安装命令。`dsh-mnemon` 自身是 MIT 的独立 DSH bundle，npm latest 0.2.13。[Mnemon README](https://github.com/mnemon-dev/mnemon) · [dsh-mnemon README](https://github.com/omdsh-dev/dsh-mnemon) · [npm registry](https://registry.npmjs.org/dsh-mnemon)

优势：

- 产品完整：Runtime Memory、Project Documents、Memory Spaces 三层；Web、conversation、headless 共用一套能力；
- 九种 long-term Provider（Mnemon、OpenViking、Honcho、Mem0、Hindsight、Holographic、RetainDB、ByteRover、Supermemory），避免锁定单一引擎；
- global/workspace/custom scope 清楚，外部 Provider 默认关闭，凭据不回传浏览器；
- 独立任务 Agent 做资格判断、去重、蒸馏和路由，主会话不承担这些历史；
- 8/14–8/20 npm 下载 8,476，是已核查 DSH 专用包中最强的公开安装兴趣信号。

弱点/机会：

- 用户需要先安装 Mnemon binary；产品能力多、认知和配置成本更高；
- “LLM supervised”表示宿主 LLM 做判断，不等于每条写入都有 Owner 明示审核；
- 文档承认没有确定性 secret scanner；
- 未发现候选集中在凌晨批处理的策略；其强项是空间/Provider 控制面，不是细粒度 Owner 审批档案。

### 4.3 Mem0：强大的通用 Provider，不是已核实的独立 DSH 原生插件

Mem0 官方仓库是 Apache-2.0 的通用 memory SDK/服务，支持 user/session/agent 层、metadata filters、多信号检索和 hosted/self-hosted。它有约 63.7k stars，生态与品牌远大于任何单一 DSH 插件。[Mem0 官方仓库](https://github.com/mem0ai/mem0) · [metadata filtering](https://docs.mem0.ai/open-source/features/metadata-filtering)

严格关系判断：

- 本次没有在 Mem0 官方仓库/官方文档中核实到 `cordis.patch.yml`、DSH 专用 package 或 DeepSeek Harness 安装说明；
- `dsh-mnemon` 明确把 Mem0 Platform/self-hosted HTTP 作为九种 Provider 之一，因此 Mem0 **可以通过 dsh-mnemon 进入 DSH**；
- DSH 官方 generic MCP client 也为未来适配提供路径，但“理论可接”不等于“官方已适配”。

竞争优势是成熟度、SDK、cloud/self-hosted、多信号召回和庞大采用面。弱点是默认功能通常需要 LLM/embedding 配置，治理和 Owner 审批不是其核心卖点。其 README 还明确警告 2026 新算法分数来自含 proprietary optimization 的 managed platform，OSS 用户只能期待方向相似、不能视作相同结果；因此不能直接用其 92.5 LoCoMo 等数字压过本地插件或作为 MistyMoon 的发布承诺。[Mem0 benchmark disclosure](https://github.com/mem0ai/mem0)

### 4.4 LivingMemory：功能相关，但不是 DSH 竞品；AGPL 风险必须隔离

“LivingMemory”名称存在歧义。本次能与“插件、长期记忆、动态生命周期”精确匹配的一手仓库是 [`gongzhudeng/astrbot_plugin_livingmemory`](https://github.com/gongzhudeng/astrbot_plugin_livingmemory)。它的 manifest、安装路径与 WebUI 都属于 AstrBot：安装到 `data/plugins`，需要 AstrBot plugin Pages；仓库没有 DSH bundle 或 DSH 安装证据。因此应分类为 **D：其他宿主插件/产品参考**，不能称为 DSH 竞品。

值得研究的产品能力包括 BM25 + Faiss + RRF、文档/图双路召回、session/persona isolation、memory atom TTL/decay、auto-forgetting、版本更新与迁移前备份、重建失败回滚、WebUI 管理。[LivingMemory README](https://github.com/gongzhudeng/astrbot_plugin_livingmemory)

许可证是 **AGPL-3.0**。MistyMoon 套件当前是 MIT 方向，不能复制其实现进入 MIT 独立仓库；只能从公开行为/接口层独立设计，或在法律审查后通过进程边界作为独立 AGPL 服务使用。[LivingMemory LICENSE](https://github.com/gongzhudeng/astrbot_plugin_livingmemory/blob/master/LICENSE)

## 5. 其他重要竞品与邻近方案

### 5.1 `dsh-memento`：最接近 MistyMoon 治理主张

`dsh-memento` 的服务层强制所有 `add/replace/remove/seed` 经过 approval waterfall，模型工具层无法绕过；配置支持 `ask | auto | off` 与 per-source override，批准/拒绝都可由 DSH session log 与 provider ledger 重建。它还拥有 user/agent × global/workspace × agentPreset scope、条目版本、schema 迁移 loud fail、待审核 compaction proposals 和协议 conformance suite。[dsh-memento README](https://github.com/PerryLink/dsh-memento)

这意味着 MistyMoon Memory 不能只宣传“人工审批、审计、SQLite、scope”，这些已经不是空白。真正可守住的差异应是：

- 每条正式记忆强制 Owner、visibility、source message ID、createdAt、revision/supersession；
- AI observations 与用户确认事实分离，未确认候选绝不参与 recall；
- 手工、立即自动、定时批量三种审核模式都走同一不可绕过的 provider/service gate；
- 审核结果及被模型看到的 Recall Snapshot 都写入可重放 DSH 日志。

### 5.2 `dsh-auto-review`：证明“第二模型自动审批”已有通用实现

同一维护者的 [`dsh-auto-review`](https://github.com/PerryLink/dsh-auto-review) 在 DSH `approval/request` answerer chain 上启动只读 one-shot reviewer，输出结构化 allow/deny/risk，默认失败关闭，并记录 `approval/asked → autoReview/verdict → approval/decided`。它支持每工具 `ai/human/never`、risk rules、超时、断路器和 Web review panel。

这是 MistyMoon 设计的重要邻近证据：**“AI 审 AI”本身不是独占差异**。尚未核实 `dsh-auto-review` 能无改动接管 `dsh-memento` 的记忆写请求，也未见按时区集中到凌晨运行，所以不能声称两者已经等价于目标流程；但独立 Memory 必须在安全性、成本、可重放性上至少达到这一通用 answerer 的水平。

### 5.3 MemOS 与 Graph Memory：召回和品牌压力

MemOS 已在官方仓库内提供 DSH cloud/local 插件：task 前自动 recall，成功 turn 后 capture；local 版为 SQLite、FTS5 + vector、去重和分层演化，cloud 版零运维。其核心仓库约 10.8k stars，远强于新 DSH-only 插件的品牌信号。[MemOS DSH install](https://github.com/MemTensor/MemOS#-memos-memory-operating-system-for-llm--ai-agents)

Graph Memory 的 DSH beta 原生接入 Session、Tool、Prompt Assembly、LLM 与 Credentials，以 TASK/SKILL/EVENT 和来源 session 构图，做 FTS5/vector/graph/PageRank 召回。本地 SQLite、embedding 可选，且明确标注现有 Pro UI 仍不是 DSH 产品。这种诚实的 shipped/planned 边界值得借鉴。[Graph Memory README](https://github.com/adoresever/graph-memory)

两者对 MistyMoon 的压力不在审批，而在“为什么用户不选召回更强/品牌更大的系统”。应对方式不是短期堆更多检索算法，而是把 Provider 做成可替换 seam：MistyMoon 负责治理、Owner、来源、审核和 DSH 投影，检索引擎可以本地默认并允许未来 adapter。

### 5.4 Mindspace：会话治理很强，但不是同一产品层

Mindspace 把 confirmed facts 与 AI observations 分开，类别冲突保持稳定 card id，append/merge/replace/skip 保留 source sequence 与 before/after，并支持 V1→V2 event replay；这是非常接近 MistyMoon 的审计表达。但它严格 session-isolated，目标是会话 personalization 与关系/使命，不是跨会话 Owner 长期档案。[Mindspace README](https://github.com/Spirtxiaoqi7/mindspace-dsh-session-memory)

这既是竞争也是互补：独立 MistyMoon Memory 应避免重新拥有 RP preset/relationship mission，把这些留给 Foundation/Persona 或其他插件，只向会话投影治理后的长期 recall。

## 6. “凌晨自动审批”是否构成可用差异

### 6.1 检索到的邻近模式

- `dsh-noema`：人工 review queue，也可 auto-accept；没有公开的按时批处理。
- `dsh-memento`：`ask | auto | off` 与 pending proposals；没有公开的夜间 batch policy。
- `dsh-memory-evolve`：按用户回合间隔 review，关键记忆需确认；不是按本地时间集中审批。
- `dsh-mnemon`：受监督任务 Agent 即时资格判断和写入；不是候选隔夜治理。
- `dsh-auto-review`：第二模型即时处理通用 DSH approval；不是记忆专用定时批处理。
- LivingMemory/MemOS/Nowledge：偏自动 capture/consolidation，没有发现 Owner 的夜间待审批队列。

因此，**可选的“手工审批 / 指定时区凌晨集中自动审批”是当前公开 DSH 市场中的可辨识差异**。但如果只是 `cron at 03:00 → approve all`，它会被视为延迟版 auto-accept，没有治理价值。

### 6.2 形成护城河所需的最小语义

建议把所谓“CI 自动审批”在产品中命名并定义为 `reviewMode`，避免 CI 与 CI/CD、Continuous Intelligence 混淆：

```text
manual
  候选只由 Owner 在 UI/命令中 accept/reject/edit/merge

automatic-immediate
  候选创建后立即进入受控 reviewer；只在策略允许且审核通过时发布

automatic-window
  候选保持 pending，按 Owner 时区与本地时间窗口批量审核
```

`automatic-window` 至少要明确：

- Owner timezone、计划时间、DST 行为、错过窗口后的补跑策略；
- 本次 run 的候选 cutoff，避免审核中不断加入导致无界任务；
- 每候选的 source message、owner、visibility、risk/sensitivity、冲突与 supersession 上下文；
- reviewer provider/model、提示词/规则版本、token/cost 上限；
- accept/reject/edit/merge/needs-human 五类结构化结果；
- 幂等 run id、逐条 decision id、崩溃恢复与只重跑未决项；
- fail closed：模型不可用、schema 不合、超时或来源丢失时保持 pending；
- 机密/跨 Owner/跨 visibility 的确定性 hard deny，不交给模型“酌情”；
- review run summary 写入 DSH 可见日志，但不把私密候选内容泄漏到其他 session；
- 用户可暂停、立即运行、预览、撤销未发布决定；正式记忆的更正用新 revision supersede，不改写历史。

这套语义比“凌晨自动总结”更难复制，也更符合 MistyMoon 已有的 Owner/visibility/source/revision 产品不变量。

## 7. 用户选择 MistyMoon Memory 的概率判断

这里不给无来源的百分比。采用**证据化分层判断**：

### 7.1 总体判断：中等，取决于是否完成独立化与治理差异

支持“有机会”的证据：

- DSH 官方 discussion 已出现明确“求 memory 能力”的需求，也有多个社区插件发布讨论，说明问题真实存在。[DSH Discussion #14](https://github.com/deepseek-ai/deepseek-harness/discussions/14) · [Mindspace Discussion #516](https://github.com/deepseek-ai/deepseek-harness/discussions/516)
- 新插件在很短时间内获得 59–205 stars，`dsh-mnemon` 一周 npm downloads 达 8,476，说明开发者愿意尝试记忆插件。
- 现有治理竞品主要是即时 ask/auto 或人工队列，尚未发现完整的定时批量审核。
- RP/长期陪伴场景对 Owner、关系边界、纠正历史和未确认候选隔离的要求，高于一般 coding memory；MistyMoon 有先验领域积累。

压低概率的证据：

- 生态已非常拥挤，用户搜索“DSH memory”会先看到 `dsh-memory-evolve`、`dsh-mnemon`、`dsh-noema`、MemOS 与 Graph Memory；“跨会话 + 本地 + WebUI”不足以被选中。
- `dsh-memento` 已占据 approval-gated/auditable/DSH-native 的清晰心智。
- Mem0/MemOS/Mnemon 有跨宿主网络效应；用户可能希望 Codex、Claude、DSH 共用一个 store，而不是只给 DSH 装一套。
- DSH 是 developer preview，兼容维护成本与用户观望都很高。
- MistyMoon 名称可能让非 RP 用户误以为插件绑定陪伴套件；独立仓库若不采用中性说明，会缩小漏斗。

### 7.2 按用户群分层

| 用户群 | 选择可能性 | 理由 |
|---|---|---|
| 已有 MistyMoon 用户，重视 RP/陪伴连续性 | 高 | 无损迁移、Owner/关系边界与既有档案是天然 switching advantage；前提是拆分后不丢功能 |
| DSH 用户，重视隐私、来源、人工治理 | 中高 | 目标功能与痛点高度匹配；夜间审核可减少白天打断 |
| DSH coding 用户，只想“一装就记住” | 中低 | `dsh-mnemon`、`dsh-memory-evolve`、MemOS 更宽或更自动；需要更好的安装和默认体验才能竞争 |
| 已使用 Mem0/MemOS/Mnemon 的跨工具用户 | 低到中 | 除非 MistyMoon 提供 provider adapter，把治理层放在其现有 store 之上，否则迁移成本高 |
| 非 DSH 的通用 agent memory 用户 | 低 | 独立仓库仍是 DSH 插件，不应把 TAM 误写成整个 agent-memory 市场 |

### 7.3 “较多用户”的可验证定义

在没有市场规模数据时，建议发布前先定义 90 天验证门槛，而不是承诺人数：

- unique clean installs（过滤 CI/user-agent）与安装成功率；
- 7/30 日仍启用插件的 profile 数；
- 产生候选的 Owner 中，实际完成一次审核的比例；
- manual / automatic-immediate / automatic-window 的选择分布；
- 夜间 run 成功率、平均 pending age、needs-human 比例、误批准/撤销率；
- 新 session 中 recall 被采纳、纠正或标记无关的比例；
- 从 MistyMoon 导入成功率和 rollback 成功率；
- issue 首响、兼容 rc 更新延迟、Windows/Desktop 安装失败率。

只有这些数据能回答“用户是否真的选择并留下来”；stars/downloads 只能作为获客漏斗顶部指标。

## 8. 独立开源的产品与仓库建议

### 8.1 清晰边界

独立仓库应明确：

- 是 DSH 原生 Memory 插件，不依赖 Foundation、Persona 或 Settings UI 套件才能运行；
- MistyMoon Foundation 不再直接读写记忆档案；双方只交换版本化 `RecallSnapshot`/服务接口；
- 默认中性命名和文案，RP 只是一个消费场景；
- 本地档案是治理事实来源，模型可见 recall/decision 仍进入 DSH 可重放日志；
- 外部 Provider 只实现可替换存储/召回，不拥有 Owner、审核、visibility、来源或修订语义。

### 8.2 首发必须超过的竞争基线

1. `dsh plugin --profile web add <package>` 一条命令，manifest 自带 bundle patch；
2. Windows/macOS/Linux，尤其 DSH Desktop 的全新安装、升级、回滚；
3. 从 MistyMoon 套件版导入的显式版本迁移、dry-run、备份、幂等和 rollback；
4. Web 审核队列 + CLI/headless 等价面；
5. 默认 manual，用户显式选择 immediate/window auto；
6. 每条记录有 owner、visibility、source message id、createdAt、revision relation、decision provenance；
7. pending/rejected/import draft 永不召回；
8. schema/version loud fail，不能静默猜测修复；
9. 本地默认、零遥测、秘密扫描与 publication audit；
10. 可复现 benchmark：不仅测 recall accuracy，还测 candidate precision、conflict/supersession、cross-owner leakage 为零、日志重建一致性。

### 8.3 发布定位建议

不建议主标题写“Long-term memory for DSH”，因为已同质化。更有辨识度的表达是：

> Governed memory for DeepSeek Harness — owner-scoped, source-backed, manually or automatically reviewed on your schedule.

中文：

> DeepSeek Harness 的可治理长期记忆：按所有者隔离、来源可追溯，可人工审批，也可在你指定的时间集中自动审核。

### 8.4 许可证与复用警戒

- MIT/Apache-2.0 竞品可依法参考公开接口和思想，但复制实现仍需保留相应 notice，并最好避免为核心治理代码形成派生争议。
- LivingMemory 为 AGPL-3.0，不复制实现到 MIT 仓库。
- Nowledge DSH 仓库在 GitHub API 中没有检测到 SPDX license；在许可证明确前不复制或分发。
- MemOS 核心与其 npm adapter 许可证不同（Apache-2.0 / MIT），依赖或打包时要逐包审计，不能只看顶层仓库。
- `dsh-noema` 自带 native binary 的方式虽然安装方便，但也意味着平台包、校验和、第三方 notice 与供应链更新都要单独维护；若 MistyMoon 未来采用相同策略，必须做可复现构建和签名/校验。

## 9. 未解决风险与后续验证

1. **“CI 自动审批”术语未定义。** 本报告按“受控自动 reviewer pipeline”理解；若 CI 指某个具体模型、服务或组织流程，需要另行核实接口、数据出境和费用。
2. **未对全部 285 个搜索候选逐仓安装。** 已对高关注、点名项目和治理特征明显者核验 README/manifest/license；长尾可能在本报告后补齐相似功能。
3. **竞品 README 功能未全部做黑盒复测。** 发布决策前建议在隔离 DSH_HOME 中对 `dsh-mnemon`、`dsh-noema`、`dsh-memento`、MemOS local、Graph Memory 做统一验收：安装、候选写入、跨 session recall、Owner 隔离、删除/恢复、重启、rc 升级。
4. **下载量不是用户量。** 可向竞品维护者或 DSH 社区请求匿名 install/retention 数据；若拿不到，只能保留“兴趣信号”表述。
5. **DSH rc 快速变化。** 官方最新已是 rc.8，本项目仍固定 rc.7，部分竞品仍标注 rc.5/rc.6；独立插件需建立项目基线/最新 release 兼容矩阵和 fail-closed 策略。
6. **自动审核质量没有统一 benchmark。** 需要建立中性数据集，覆盖明确事实、敏感信息、冲突、他人私密内容、讽刺/否定、临时事项、过期信息和来源缺失；同时测 false accept，而不是只测召回命中率。
7. **外部 Provider 的删除语义不同。** dsh-mnemon 明确不会替 Provider 发明 graph/delete/list 能力；MistyMoon adapter 也必须暴露 capability difference，并验证永久删除是否真的级联到索引、备份与恢复清单。

## 10. 最终判断

**建议拆分并开源。** 但成功条件是把它做成“治理层”而非“仓库搬家”：

- 以 `dsh-memento`/`dsh-noema` 为治理最低对标；
- 以 `dsh-mnemon`/MemOS 为安装、UI、Provider 与采用对标；
- 以 Graph Memory/Mem0 为召回和评测对标；
- 以 LivingMemory 的生命周期、备份与回滚作为只读产品参考，不接触其 AGPL 实现；
- 把“Owner 可选择人工或本地时区凌晨自动审核”做成统一、可重放、失败关闭的核心 seam。

若这些条件落实，独立 MistyMoon Memory 在“重视隐私与治理的 DSH 用户”和原 MistyMoon 用户中有**中高**吸引力，在整个 DSH memory 市场中有**中等**获得显著用户选择的机会。若仅把现有包改名搬出、仍缺一键安装/迁移/中性定位/公开评测，则面对已经有 100+ stars、成熟 npm 安装和强 Provider 生态的竞品，选择概率会降到**中低**。
