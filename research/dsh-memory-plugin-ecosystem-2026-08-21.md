# DSH 记忆插件生态与 dsh-Mmem 开源判断

> 调研时点：2026-08-21（Asia/Shanghai）  
> 项目基线：独立 `dsh-Mmem` 仓库，DSH 完整验证基线 `0.1.0-rc.8`，公开 peer range `>=0.1.0-rc.7 <0.1.0`。  
> 证据边界：优先使用官方仓库、manifest、release、npm registry/API 和官方文档；未把 README 自述等同于逐项黑盒复测。  
> 隐私边界：调研未读取真实 Persona、Memory、DSH Home、会话或凭据。

## 结论

建议独立开源。dsh-Mmem 的可守差异不是“能跨会话记忆”，而是：

> DSH 原生、Owner 隔离、来源可追溯、默认人工审核、可按 Owner 时区定时自动审核，并以可治理 Memory Spaces 控制多个 DSH Workspaces 之间的共享。

当前公开竞品分别覆盖了候选队列、即时自动接受、强检索、多 Provider、WebUI 或来源审计，但本次未发现一个项目同时完整提供以下组合：

- pending 候选与正式记忆严格隔离；
- 逐条、批量人工审批；
- 用户时区和本地时间驱动的集中自动审核；
- fresh、无工具 DSH Agent Session 给出结构化建议；
- 提交前重新校验 Owner、Workspace Binding、Space、策略 revision、候选快照、来源和冲突；
- 多个独立 Space、一个 Space 绑定多个 DSH Workspaces；
- isolated / selective / federated 三种跨 Space 策略及可追溯 Borrowed Recall receipt。

获得显著用户选择的总体概率判断为“中等”；在原 MistyMoon 用户，以及重视隐私、来源和人工治理的 DSH 用户中为“中高”。该判断不能换算成绝对用户数；DSH 仍处 developer preview，竞品也普遍很新。[DSH 官方 README](https://github.com/deepseek-ai/deepseek-harness/blob/master/README.md)

## 调研口径

本文把候选分为四层：

1. DSH 原生插件：有 DSH bundle/patch、安装说明与版本证据；
2. DSH adapter：外部记忆引擎已有明确 DSH 接入；
3. 可替换 Provider：可以成为检索/存储后端，但不拥有 dsh-Mmem 治理语义；
4. 其他宿主或通用产品：只作产品参考，不称为直接 DSH 竞品。

GitHub `topic:dsh-plugin memory` 在调研时返回 285 个候选，但包含“内存监控”、其他宿主和仅在说明中出现 memory 的噪声，因此不能当作 DSH 记忆插件总数。[GitHub Search API](https://api.github.com/search/repositories?q=topic%3Adsh-plugin%20memory&sort=stars&order=desc&per_page=100)

## DSH 官方边界

DSH 的扩展 cookbook 把 Memory 定义为可组合的 section provider + tool，官方 CLI 通过 npm manifest 的 `dsh.bundle.patch` 安装树外插件；这支持 dsh-Mmem 保持独立插件、且不修改 DSH 源码。[扩展 cookbook](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/cookbook/extension-cookbook.md) · [CLI reference](https://github.com/deepseek-ai/deepseek-harness/blob/master/apps/cli/reference/README.md)

官方还提供 Memorix、MCP Reference Memory 与 Engram 的默认关闭 MCP 示例，并明确它们是互操作示例而非背书或持续支持。DSH 只拥有连接和工具生命周期，Provider 的身份、存储、迁移与许可证仍由 Provider 负责。[官方 MCP memory 示例](https://github.com/deepseek-ai/deepseek-harness/blob/master/examples/mcp-memory/README.md)

因此，MCP 是免费连接基线，不是 Owner 治理基线。dsh-Mmem 应继续拥有身份、候选状态、审批、visibility、revision、DSH 日志投影和审计；外部引擎只实现可替换 Provider。

## 直接竞品快照

以下 stars、forks 与 npm downloads 是 2026-08-21 的兴趣快照，不等于活跃用户或留存。

| 项目 | 关系与公开信号 | 主要优势 | dsh-Mmem 的机会 | 许可证 |
|---|---|---|---|---|
| [`dsh-memory-evolve`](https://github.com/csyangwen/dsh-memory-evolve) | DSH bundle；约 205 stars / 14 forks | 多轨档案、项目/每日记忆、Git 同步、低依赖 | Git 同步扩大私密误推风险；未见定时治理与 Space 授权图 | MIT |
| [`dsh-mnemon`](https://github.com/omdsh-dev/dsh-mnemon) | npm；约 136 stars；8/14–8/20 下载 8,476 | Runtime/Documents/Spaces 三层、九 Provider、WebUI、较强安装兴趣 | 需要额外 Mnemon binary；LLM supervised 不等于 Owner 逐条审核 | 插件 MIT；引擎 Apache-2.0 |
| [`dsh-noema`](https://github.com/ZSeven-W/dsh-noema) | npm bundle；约 116 stars；周下载 726 | pending/accept/reject/edit/merge，BM25 + PageIndex + graph/RRF，多来源导入 | wrapper 默认 auto-accept on；未见按时区集中审核 | MIT |
| [`dsh-memento`](https://github.com/PerryLink/dsh-memento) | npm/GitHub bundle；约 59 stars；周下载 1,292 | 不可绕过 approval waterfall、per-source policy、审计、版本与迁移 | 已占据治理心智；dsh-Mmem 必须用定时审核和 Space sharing 拉开差异 | Apache-2.0 |
| [`dsh-mneme`](https://github.com/modusensus/dsh-mneme) | DSH 原生结构化记忆；约 30 stars | 原生结构化模型 | 采用与治理证据较弱 | MIT |
| [MemOS](https://github.com/MemTensor/MemOS) | 官方仓库含 DSH local/cloud adapters；核心约 10.8k stars | 品牌、FTS5/vector/graph、异步 ingest、本地/云 | 治理不是主卖点；可作为未来 Provider | 核心 Apache-2.0；adapter MIT |
| [Graph Memory](https://github.com/adoresever/graph-memory) | DSH beta；约 562 stars / 80 forks | TASK/SKILL/EVENT 图、vector + FTS5 + graph + PageRank、来源 session | 当前 DSH beta 安装摩擦高；未见候选审批控制面 | MIT |
| [Mindspace Session Memory](https://github.com/Spirtxiaoqi7/mindspace-dsh-session-memory) | DSH bundle；约 3 stars | confirmed/observation 分离、事件回放、source sequence | 定位严格 session-isolated，不是跨会话 Owner 档案 | MIT |
| [Nowledge Mem DSH](https://github.com/nowledge-co/nowledge-mem-deepseek-harness) | DSH bundle + 本地/远端服务 | startup recall、turn-end capture、Space | 自动 capture；许可证未被 GitHub API 识别，复用前须澄清 | 未明确 |

npm 下载来源：[dsh-mnemon](https://api.npmjs.org/downloads/point/2026-08-14:2026-08-20/dsh-mnemon)、[dsh-noema](https://api.npmjs.org/downloads/point/2026-08-14:2026-08-20/%40zseven-w%2Fdsh-noema)、[dsh-memento](https://api.npmjs.org/downloads/point/2026-08-14:2026-08-20/dsh-memento)、[MemOS local](https://api.npmjs.org/downloads/point/2026-08-14:2026-08-20/%40memtensor%2Fmemos-local-plugin)、[MemOS cloud](https://api.npmjs.org/downloads/point/2026-08-14:2026-08-20/%40memtensor%2Fmemos-cloud-dsh-plugin)。

## 重点竞品分析

### dsh-memento：治理最低对标

它的服务层让 `add/replace/remove/seed` 统一经过 approval waterfall，配置有 `ask | auto | off` 与 per-source override，批准/拒绝能由 DSH session log 与 ledger 重建，还提供 user/agent × global/workspace × preset scope、条目版本和迁移 loud fail。[dsh-memento README](https://github.com/PerryLink/dsh-memento)

所以“人工审批、审计、scope、SQLite”本身不足以差异化。dsh-Mmem 的优势必须落在：未确认候选永不召回、每条记录强制来源和 revision、定时自动审核仍经过相同治理门、以及跨 Space 读取保留授权 receipt。

### dsh-noema：候选工作流与检索最低对标

其 Rust 核心是 [`ZSeven-W/noema`](https://github.com/ZSeven-W/noema)，不是同名 Go 项目 Fail-Safe/Noema。它提供 pending candidate、accept/reject/edit/merge、sensitivity 与 payload-free audit；DSH wrapper 还带 Web 设置和多种 coding-agent 导入。[dsh-noema README](https://github.com/ZSeven-W/dsh-noema)

其优势是安装与检索面完整；机会在于 wrapper 默认自动接受、公开资料未见用户时区夜间批审，也未见 dsh-Mmem 当前的 exact policy/Binding revision 重校验。

### dsh-mnemon：产品完整度与采用最低对标

Mnemon 有 Runtime Memory、Documents、Memory Spaces，并接入 Mnemon、OpenViking、Honcho、Mem0、Hindsight、Holographic、RetainDB、ByteRover、Supermemory 九种 Provider；external Provider 默认关闭。[Mnemon README](https://github.com/mnemon-dev/mnemon) · [dsh-mnemon README](https://github.com/omdsh-dev/dsh-mnemon)

它证明用户重视一装即用、WebUI 与 Provider 选择。dsh-Mmem 不应短期竞逐 Provider 数量，而应让治理层足够稳定，未来可把 Mnemon/Mem0/MemOS 类引擎放到隔离 Provider seam 后面。

### Mem0、MemOS、Graph Memory：品牌与召回压力

[Mem0](https://github.com/mem0ai/mem0) 是成熟通用 SDK/服务，具有 metadata filtering、cloud/self-hosted 与庞大生态，但未核实到其官方独立 DSH bundle；目前可经 dsh-mnemon Provider 进入 DSH。[Mem0 metadata filtering](https://docs.mem0.ai/open-source/features/metadata-filtering)

MemOS 和 Graph Memory 的优势是向量、图、异步 ingest 与品牌。dsh-Mmem 的正确应对是保持 BM25 本地默认和严格 Archive backcheck，同时用可替换 Provider 承接更强检索，不把 Owner、审批和删除语义交给引擎。

### dsh-auto-review：AI 审核不是独占差异

[`dsh-auto-review`](https://github.com/PerryLink/dsh-auto-review) 已能在 DSH approval chain 中启动只读 one-shot reviewer，给出结构化 allow/deny/risk，并默认失败关闭。它不是记忆专用夜间 batch，但证明“第二模型自动审批”本身已有邻近实现。

dsh-Mmem 的差异来自完整组合：candidate cutoff、每日 slot、DST、跨进程 lease、payload-free receipt、fresh no-tool Session、durability listener，以及提交前治理事实重读。

### LivingMemory：只作产品参考

[`astrbot_plugin_livingmemory`](https://github.com/gongzhudeng/astrbot_plugin_livingmemory) 属于 AstrBot，不是 DSH 插件。它的 BM25/Faiss/RRF、TTL/decay、备份、迁移失败回滚值得研究，但许可证是 AGPL-3.0；不得复制实现进本 MIT 仓库。[LivingMemory LICENSE](https://github.com/gongzhudeng/astrbot_plugin_livingmemory/blob/master/LICENSE)

## Memory Spaces 是否形成差异化

能，但必须坚持“治理和授权空间”而不是“又一个 namespace”。当前实现已经满足关键条件：

- DSH Workspace 身份只来自 live `SessionHeader.cwd`，插件不创建平行 Workspace 模型；
- 一个 Memory Space 可绑定一个或多个 DSH Workspaces；一个 Workspace 由 Binding 选择唯一 Active/Default Write Space；
- 多个 Space 物理 Archive 隔离；新 Space 默认不互通；
- `isolated` 完全不扩展；
- `selective` 是 Source → Target 单向、只读、非传递 Grant，并过滤 Memory Kind/visibility；
- `federated` 只在显式、不重叠的 Federation 成员间互相召回；
- Borrowed Recall 保留 Source Space、relation、policy revision，重新施加一次全局数量/字符预算；
- 授权在读取期间变化时，借用结果全部丢弃；借用 ID 不能通过 Active Space facade 修改。

竞品中的 global/workspace/custom scope 或 Provider namespace 解决的是“记忆放哪里”；dsh-Mmem 的 Space 模型额外回答“哪个 DSH Workspace 可以以何种、可审计的关系读取它”。这是更接近访问控制与数据治理的产品语义。

## 定时自动审核是否形成差异化

能。当前 `manual` 与 `scheduled-auto` 共用治理路径，后者不是 `cron → approve all`：

- Owner 显式设置 IANA 时区和本地 `HH:mm`；默认仍为 manual；
- DST 缺失时间顺延到首个有效时刻，重复时间取第一次；
- 首次启用只武装下一 slot，不回填旧日期；
- 跨进程 lease 与每日 receipt 避免重复运行；
- 每候选用 fresh、无 parent/seed、无工具 DSH Agent Session 获取严格 JSON 建议；
- 低置信度、解析失败、`boundary`、`commitment`、冲突、治理 revision 变化一律 defer；
- 正式写入前重读 trusted Owner、Workspace Binding、Space、策略、候选、来源和 deterministic conflict；
- DSH Session request/response 与最终模型可见内容可重建审核过程。

公开竞品普遍在“人工队列”与“即时 auto-accept”之间选择；本次未发现同等的本地时区集中审核与治理重校验组合。

## 用户选择判断

| 用户群 | 选择可能性 | 判断依据 |
|---|---|---|
| 现有 MistyMoon 用户 | 高 | 独立迁移、既有长期档案、Owner 与关系边界降低切换成本 |
| 重视隐私、来源和人工治理的 DSH 用户 | 中高 | 目标功能与痛点高度匹配，夜间审核减少白天打断 |
| 只求“自动记住”的 coding 用户 | 中低 | dsh-mnemon、Memory Evolve、MemOS 更宽或更自动 |
| 已有跨工具 Mem0/MemOS/Mnemon 用户 | 低到中 | 除非 dsh-Mmem 提供 Provider adapter，否则迁移成本高 |
| 非 DSH 用户 | 低 | 本项目有意保持 DSH 插件边界 |

要把“中等”提升为“中高”，首发还应做到：

1. 官方 DSH 最新 rc 的 clean Profile 安装与真实 UI smoke；
2. 一个可手动上传的单一 npm tarball，README、tag、锁文件、包版本一致；
3. MistyMoon 旧 SQLite 的 plan/apply/rehearse/rollback 文档化演练；
4. 中性定位，不让非 RP 用户误以为依赖 Persona；
5. 可复现 benchmark：candidate precision、false accept、冲突/supersession、cross-owner leakage、日志重建一致性；
6. rc 更新响应时限和 90 日留存指标。

建议关注 unique clean installs、安装成功率、7/30 日仍启用、候选审核完成率、manual/scheduled-auto 分布、自动 run 成功率、needs-human/误批准率、recall 采纳/纠正率、迁移与 rollback 成功率。Stars 和 downloads 只能描述漏斗顶部。

## 许可证与复用边界

- MIT/Apache-2.0 项目可以参考公开接口和产品思想；复制代码仍须遵守 notice 与归属。
- LivingMemory 为 AGPL-3.0，不复制实现到本仓库。
- Nowledge Mem DSH 顶层许可证未明确前，不复制或再分发。
- MemOS 核心和 npm adapters 许可证不同，接入时按具体包审计。
- 带 native binary 的竞品安装顺滑，但也引入平台构建、校验和、签名与供应链维护；dsh-Mmem 当前纯 JS tarball 避开了这一风险。

## 最终判断

dsh-Mmem 已经不只是 MistyMoon 的仓库搬家。它当前把候选治理、DSH 日志可重建审核、Workspace-bound Spaces、三种互通策略和授权可追溯 Borrowed Recall 组合成了一个市场上可辨识的控制面。

发布定位建议：

> Governed memory for DeepSeek Harness — owner-scoped, source-backed, manually or automatically reviewed on your schedule.

中文：

> DeepSeek Harness 的可治理长期记忆：按所有者隔离、来源可追溯，可人工审批，也可在你指定的时间集中自动审核。

只要保持最新 DSH rc 兼容、单包安装、迁移可回滚与治理评测，项目在隐私/治理型 DSH 用户中有中高吸引力，在整个 DSH memory 市场中有中等获得显著用户选择的机会。
