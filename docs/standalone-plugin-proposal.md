# 018：Memory 独立 DSH 插件与定时自动审批提案

状态：提案，等待 Owner 确认术语、仓库名、分发方式和自动审批范围；本文件不授权搬仓、发布、迁移真实档案或启用模型 Provider。

基线：MistyMoon `69ea9809079007ab0bff6abfa58c8cd3483f8044`；DSH `0.1.0-rc.7`。调研日期：2026-08-21（Asia/Shanghai）。

配套生态报告：[`research/dsh-memory-plugin-ecosystem-2026-08-21.md`](research/dsh-memory-plugin-ecosystem-2026-08-21.md)。

## 决策摘要

1. 建议把 Memory 从 MistyMoon monorepo 拆成独立 DSH 插件仓库；MistyMoon 以后只组合并消费它，不再拥有其 Archive、治理、召回、设置页或迁移实现。
2. 第一版保留当前包名 `@mistymoon/dsh-memory` 可显著降低迁移成本；仓库独立不要求立即改品牌。若要改名，应作为后续单独迁移，不与拆仓同时进行。
3. 当前实现不能直接搬走：Archive implementation 基本自洽，但插件运行时依赖 `mistymoonOwnerEligibility`，Memory UI 与 Host RPC 混在 `packages/settings-ui`，根 bundle、installer、脚本、文档和 132 处文本引用仍由套件组合。
4. “凌晨自动审批”必须是用户本机 DSH Runtime 内的可取消调度任务，不是 GitHub Actions 或其他 CI runner。CI 不应接触私有记忆、用户 DSH Home 或 Owner 凭据。
5. 若需求中的“CI”实际指“AI”，建议提供 `manual` 和显式 opt-in 的 `scheduled-auto` 两种模式。默认必须为 `manual`；模型只产生结构化建议，Memory Module 根据已持久化的 Owner Policy Grant 决定是否提交。
6. 自动审批 v1 只处理低风险、`personal`、无冲突、来源完整的 `preference` / `biographical` 候选。`confidential`、`boundary`、`commitment`、`relationship`、`state`、导入、合并、冲突和来源缺失一律留给人工。
7. 当前能力在“本地、可审计、Owner/scope/source 治理”这一 DSH 细分市场具有明确差异化；但在独立安装、默认智能检索、Provider 易用性、公开 benchmark、真实用户证明和 rc.7 兼容验证上仍有缺口，不能据此承诺会有“大量用户”。

## 术语澄清

本提案把用户原文中的“CI 自动审批”按两种可能解释处理：

- 若是 **AI 自动审批**：采用本文的 `Approval Evaluator` 与本机定时批处理设计。
- 若是 **Continuous Integration 自动审批**：明确拒绝。CI 只运行中性 fixture、类型检查、测试、构建、兼容性冒烟和发布审计；它不读取或修改用户档案。

在 Owner 确认前，代码、配置和 UI 不应出现含糊的 `ciApproval` 命名。

## 当前形状与拆仓阻点

当前 Git 基线中，`packages/memory` 有 34 个 tracked 文件，另有两个 Memory 维护/迁移脚本。Memory 的核心源码没有静态导入 Foundation 或 Settings UI，但仍存在以下运行时和组合耦合：

| 耦合 | 当前事实 | 独立仓库要求 |
| --- | --- | --- |
| Owner 身份 | `inject` 硬依赖 `mistymoonOwnerEligibility`，并以字符串取得私有 Cordis Context service | 改为 Memory 自己拥有的 `MemoryPrincipalResolver` Interface；提供 DSH loopback Adapter，MistyMoon 可提供可选 Adapter |
| 设置与审核 UI | Memory Host RPC、runtime settings 和 React 页面位于 MistyMoon `settings-ui` | 移入独立插件的 Host + client 包；MistyMoon 页面只保留跳转或组合 slot |
| 私有路径 | bundle 使用 `dshHomePath('mistymoon', ...)` | 新安装使用独立目录；旧路径只经显式 plan/apply 迁移 |
| 组合入口 | 根 `cordis.patch.yml`、root exports、build、installer 和 smoke 直接列出 Memory | 独立仓库拥有自己的 DSH bundle manifest、build、smoke 和 publication audit |
| 维护工具 | CLI 位于根 `scripts/` | 随独立插件发布版本化、默认只读的 maintenance CLI |
| 产品文档 | README、architecture、P0/P1 specs 把 Memory 描述为 MistyMoon 子模块 | MistyMoon 改为外部依赖；Memory 仓库拥有治理语义和格式文档 |
| 发布状态 | 根包和 Memory 包均 `private: true` | 必须单独决定 DSH 官方支持的分发 seam；不得沿用 MistyMoon 已放弃的用户安装叙述 |

### 保留的资产

- v2 hash-linked transaction Archive、checkpoint、lease、quarantine 和显式 maintenance plan。
- Owner / authority / scope / visibility / Observation / source lineage 的领域模型。
- pending candidate、批准/拒绝、冲突、supersession、编辑/合并和无正文审计。
- BM25 baseline、Archive backcheck、Recall Snapshot 与 DSH 模型可见日志。
- Candidate Extraction、Advanced Retrieval 和 Derived View 的受限 seam。
- 当前中性测试与故障注入用例。

### 不原样保留的资产

- `mistymoon*` Cordis service 名称和工具文案。
- 对 Companion Reality 的硬编码默认。独立插件需要通用 scope Adapter；MistyMoon 再提供 RP scope 映射。
- 混合 Persona/Work/Memory 的 Settings Host 和 settings document。
- `mistymoon/` 私有路径与套件 installer 假设。
- “所有抽取候选永不自动批准”的绝对表述；替换为“默认人工，只有 Owner Policy Grant 明确授权的安全子集可自动确认”。

## 目标 Module

独立仓库对 DSH 和 UI 暴露一个深 Module。callers 不学习 JSONL event、冲突算法、模型 prompt、timer、重试、lease 或来源回查的顺序。

```text
DSH Agent / Settings client / Maintenance CLI
                    │
                    ▼
        Governed Memory Interface
      observe · govern · recall · inspect
                    │
      ┌─────────────┼─────────────┐
      ▼             ▼             ▼
  Archive       Approval       Recall
implementation  implementation implementation
      │             │             │
      └──── authoritative records ┘
                    │
        ┌───────────┴───────────┐
        ▼                       ▼
DSH Runtime Adapter     Settings Host/client Adapter
```

删除该 Module 后，Owner/scope/source/approval/revision/recall/logging 规则会重新散落到工具、UI、Provider 和 scheduler 中，因此它具备足够 Depth。Archive、Clock、Evaluator 和 DSH transport 是 implementation 内部 seam，不应扩大公共 Interface。

### 对外 Interface

公共 surface 应收敛为四类操作，而不是继续为每个 JSONL event 暴露一个 method：

```ts
interface GovernedMemoryV1 {
  observe(request: ObserveRequestV1): Promise<ObserveResultV1>
  govern(request: GovernanceRequestV1): Promise<GovernanceResultV1>
  recall(request: RecallRequestV1): Promise<RecallSnapshotV1>
  inspect(request: InspectionRequestV1): Promise<InspectionResultV1>
}
```

- `observe` 隐藏显式记住、候选写入、来源幂等和批次事务。
- `govern` 以 tagged union 表达人工决定、策略 grant/revoke、scheduled run 和生命周期计划。
- `recall` 统一执行 scope/visibility/status filter、Provider、Archive backcheck、预算与 receipt。
- `inspect` 提供无正文健康、迁移、quarantine、scheduler 和 Provider 状态。

已有细粒度类可以留在 implementation 内，但 DSH tools、Settings Host、maintenance CLI 和 tests 应逐步改为穿过同一个 Interface。Interface 是主要测试 surface。

### 真实 external seams

只保留确有多个 Adapter 的 seam：

1. `MemoryPrincipalResolver`
   - DSH loopback Adapter：独立插件默认的单 Owner 本机部署。
   - MistyMoon Adapter：把既有 Owner/channel/fiction scope 证据映射进通用 principal。
   - test Adapter：中性固定 principal。
2. `CandidateExtractionProvider`
   - 无 Provider / local deterministic fixture。
   - DSH model-backed 或未来本地模型 Adapter。
3. `ApprovalEvaluator`
   - deterministic policy test Adapter。
   - DSH model-backed Adapter。
4. `RecallIndexProvider`
   - 内置 BM25。
   - PageIndex、graph、Mem0 等可选 Adapter。

Timer/Clock 只需作为 internal seam 接受 production clock 与 fake clock，不应成为用户面对的插件 Interface。

## 审批模式

### 配置模型

```ts
type ApprovalModeV1 =
  | { kind: 'manual' }
  | {
      kind: 'scheduled-auto'
      localTime: `${number}${number}:${number}${number}`
      timeZone: string
      batchSize: number
      minimumCandidateAgeMinutes: number
      missedRunGraceMinutes: number
      evaluatorRef: string
      policyRevision: string
    }
```

约束：

- 缺失设置、旧 schema、无效时区或 Provider 不可用都 fail closed 为 `manual`，不能猜测。
- `scheduled-auto` 只能由本机 loopback Settings 操作创建 `OwnerPolicyGrantV1` 后生效；编辑时间、范围或 Provider 会产生新 revision。
- UI 必须同时显示下次运行时间、时区、允许自动批准的种类、强制人工范围和最近一次无正文结果。
- 不接受任意 cron expression。第一版只需要“每天一个本地时间”，这样 DST、错过运行和 UI 解释都更确定。

### 自动审批资格

所有条件都成立才可进入 Evaluator：

1. candidate 仍为 `pending`，Archive generation 与 run snapshot 一致；
2. `visibility === 'personal'`；
3. `memoryKind` 为 `preference` 或 `biographical`；
4. 来源是已认证 Owner 的单条或同一 turn 的有限消息集合；
5. source message 仍可回查，且候选没有跨 scope 合并；
6. deterministic conflict assessment 为 `novel` 或允许的 exact duplicate 处理，不存在 conflict / supersession 决策；
7. 不是 import、merge、relationship inference、emotion inference 或 Work child 输出；
8. 满足最小年龄，避免在对话仍可能继续纠正时立即确认；
9. 当前 Policy Grant 未撤销，revision 与 scheduled run 捕获的 revision 一致。

以下内容在 v1 永远 `defer` 给人工：

- `confidential`；
- `boundary`、`commitment`、`relationship`、`state`、`summary`、`episode`；
- 冲突、近重复但不能确定相同、需要 supersede 的候选；
- 导入、编辑、合并、批量迁移产生的候选；
- 来源丢失、scope/authority 不一致、模型输出声称获得授权的候选。

### Approval Evaluator

Evaluator 只返回不可信建议，不能调用 Archive：

```ts
interface ApprovalEvaluationV1 {
  schemaVersion: 1
  candidateId: string
  recommendation: 'approve' | 'defer'
  confidence: number
  reasonCodes: readonly ApprovalReasonCodeV1[]
  citedObservationIds: readonly string[]
  receipt: ModelEvaluationReceiptV1
}
```

- v1 不允许自动 `reject`。不通过自动门的候选继续 pending，避免模型把可能有价值的记忆静默隐藏。
- `confidence` 不能单独授权；必须同时通过 deterministic eligibility、strict schema、citation equality 和 policy threshold。
- DSH model-backed Adapter 使用 fresh、neutral、no-tools Session，不继承 RP Persona、父 transcript 或 Recall Snapshot。
- Evaluator 请求/响应必须由 DSH Session 日志重建；Archive event 只保存 session/request 引用、Provider revision、reason code 和 Policy Grant digest，不复制模型思维链。
- timeout、cancel、invalid schema、missing citation、Provider error 或 route change 都产生 `defer` receipt，不影响普通 Owner turn。

### 本机定时流程

```text
每天 Owner 配置的本地时间
  -> 读取并校验最新 OwnerPolicyGrant
  -> 获取跨进程 scheduled-run lease
  -> 冻结 pending candidate IDs + archive generation
  -> deterministic eligibility / conflict assessment
  -> 有界批量调用 ApprovalEvaluator
  -> 对每条重新回查 candidate、source、policy revision
  -> 满足全部条件：append approved transaction
  -> 其他：保持 pending，并追加 payload-free run receipt
  -> 发布下次运行时间与统计
```

调度 implementation 要求：

- 使用插件自有、可取消 timer，并由 `ctx.effect()` 返回 disposer；不得创建无人拥有的后台进程。
- 同一 Archive 同时最多一个 scheduled run；复用或扩展现有 lease，run ID + policy revision + candidate ID 保证幂等。
- DSH 在计划时间离线时，只在启动后且仍处于 `missedRunGraceMinutes` 内补跑一次；超出窗口等待下一天，不多日追赶。
- DST 重复小时同一 calendar date 只运行一次；跳过小时按 grace 规则处理。时区必须保存 IANA name，不能只存 UTC offset。
- 新的 Owner 手动决定优先；scheduled commit 前必须重读，已处理或 generation 改变的 candidate 逐项跳过。
- dispose 等待已开始的单条 Archive commit，取消尚未开始的模型请求，并给出无正文的 partial receipt。

## 数据与审计变化

建议增加版本化记录，而不是把 scheduler 状态塞进 candidate：

- `OwnerPolicyGrantV1`：Owner、authority、scope、mode、允许范围、Provider ref、revision、createdAt、source request ID、revokedAt。
- `ApprovalRunV1`：run ID、planned local date/time、actual start/end、policy revision、archive generation、eligible/deferred/approved/failed counts。
- `ApprovalDecisionEventV1`：actor 为 `owner-manual` 或 `owner-policy`；自动路径额外记录 evaluator receipt 与 policy digest。
- `SchedulerCheckpointV1`：最近已处理 local date、next run、last result；不含候选正文。

Archive 仍是唯一事实来源。scheduler checkpoint 可以重建或单独原子保存，但不能让“checkpoint 已完成、Archive 未提交”的状态导致候选被永久跳过。

## 独立仓库建议形状

```text
dsh-memory/
├─ packages/
│  ├─ memory-core/          # domain、Archive、governance、recall、approval policy
│  ├─ memory-dsh/           # Cordis/DSH runtime、tools、session projection、loopback Host
│  └─ memory-dsh-client/    # DSH Settings 页面
├─ scripts/                 # maintenance / migration / publication audit
├─ specs/                   # storage、scope、approval、retrieval、lifecycle
├─ fixtures/                # 仅中性生成数据
├─ cordis.patch.yml
├─ README.md
└─ THIRD_PARTY_NOTICES.md
```

如果三个包造成不必要的发布复杂度，也可由一个 package 提供 root、`./core` 和 `./client` exports；关键是 implementation ownership 与构建 target 分开，不是 package 数量本身。

## MistyMoon 集成

拆仓后职责应变为：

```text
MistyMoon Foundation / RP Host
  -> 提供 Owner + RP scope Adapter
  -> 消费独立 Memory 的 Recall Snapshot
  -> 不读取 Archive，不复制审批规则

Standalone Memory
  -> 拥有 observation/candidate/confirmed/revision/archive
  -> 拥有审批策略、scheduler、Memory Settings UI
  -> 通过 DSH Session 持久化模型可见 recall/evaluation
```

MistyMoon bundle 可以预装或引用固定版本的独立 Memory，但不能再从 MistyMoon monorepo 源码直接导入其实现，也不能把 settings handlers 或 archive path 当作套件私有实现。Foundation 继续拥有 Persona；独立 Memory 不解释、发布或修改 Persona。

## 拆仓顺序

每一步都应是可回滚的小提交，且不同时修改 DSH 源码：

1. **冻结契约**：为当前 `CompanionMemoryArchive`、governance facade、DSH projection 和 maintenance 写跨仓验收 fixture；记录 rc.7 compatibility baseline。
2. **深化 Module**：在原仓先引入 `GovernedMemoryV1`，让 tools、Settings 和 tests 穿过统一 Interface；不改变格式。
3. **解除身份耦合**：引入 `MemoryPrincipalResolver`，实现 loopback 与 MistyMoon 两个 Adapter；删除 `mistymoonOwnerEligibility` 字符串依赖。
4. **分离 UI**：把 Memory Host endpoints、client tab、locales 和 runtime settings 移到 Memory-owned target；MistyMoon Settings 不再依赖 Memory contracts。
5. **提取 Git 历史**：从已审计 commit 使用 history-preserving filter 创建新仓库；不得复制私有数据、构建制品、日志或真实 archive。
6. **建立独立 bundle**：添加独立 manifest、build、typecheck、test、built smoke、publication audit 和第三方通知。
7. **回接 MistyMoon**：以固定版本依赖或 Desktop 内部 artifact 组合，不从 workspace 源码导入；保持旧功能回归。
8. **显式数据迁移**：提供 old MistyMoon path -> new Memory path 的只读 plan、exact digest、backup、Owner confirm、apply 和 rollback rehearsal；不自动移动真实档案。
9. **先交付人工版**：独立插件首次公开版保持 `manual`，取得安装和数据兼容证据。
10. **再交付 scheduled-auto**：先加 fake clock / deterministic evaluator 红灯，再实现本机 scheduler 和 DSH model-backed Adapter；默认仍关闭。

不要把拆仓、改包名、改 Archive schema、增加 AI Provider、改默认审批和公开发布合并成一个版本。

## 发布与采用门槛

公开前至少满足：

- DSH rc.7 clean profile 的 bundle install/load/restart/uninstall smoke。
- Windows 下全新安装、升级、旧 MistyMoon Archive plan/apply、回滚和用户数据保留测试。
- `manual` 与 `scheduled-auto` 的模式切换、撤销、时区、DST、离线补跑、HMR/dispose 和双进程 lease 测试。
- 自动审批 0 次越权、0 次跨 Owner/scope、0 次 confidential 自动确认、0 次冲突自动 supersede。
- 至少一套公开中性 evaluation corpus，报告 precision、defer rate、false approval rate、延迟和模型成本；不要只报告 recall hit rate。
- README 在三分钟内解释“为什么不是向量数据库”“数据在哪里”“模型是否会看到私密内容”“如何完全关闭 AI”。
- 许可证、第三方资产、模型 Provider 条款和发布文件审计通过。
- 安装入口、版本兼容矩阵、故障恢复和导出路径有文档；发布动作另行取得 Owner 授权。

## 市场判断框架

不能从 GitHub stars 或候选仓库数量直接推断用户选择。发布后的判断应分三层：

1. **可发现**：仓库访问、README -> install 转化、DSH topic/目录收录、release 下载。
2. **可安装**：clean DSH 首次加载成功率、Windows 安装失败率、首次完成召回的时间。
3. **愿意留下**：7/30 日仍启用、候选处理量、manual/scheduled-auto 选择、误批准撤销率、卸载时数据导出率。

当前的合理结论是：

- 对需要本地、可审计、来源明确、可手动治理的 DSH 用户，产品有较强差异化。
- 对只想“安装即自动记住”、期待 embeddings/graph/cloud sync 的用户，当前默认 BM25、无捆绑 Provider 和严格审批会显得较重。
- DSH 本身仍处 rc 阶段，公开生态的绝对用户盘和插件安装数据未知；因此只能判断细分适配度，不能可靠预测“较多用户”的绝对数量。
- 最可信的市场验证不是继续增加 feature，而是先发布人工审批 MVP，招募 10–20 个中性测试用户，量化安装成功、7 日留存、候选 precision 和治理负担，再决定 scheduled-auto 的默认呈现。

## 验收场景

1. 默认安装后没有 Owner Policy Grant，所有抽取结果保持 pending。
2. Owner 在 loopback UI 开启每天 04:00、`Asia/Shanghai` 的 scheduled-auto，设置与 policy revision 持久化且可撤销。
3. 03:59 新建一个低风险 personal preference；04:00 evaluator 建议 approve，Memory 回查来源/无冲突/政策一致后原子确认。
4. 同批 confidential、relationship、conflict 和 imported candidate 全部仍 pending，并显示稳定 defer reason。
5. 04:00 DSH 离线、06:00 在 grace 内启动时只补跑一次；超过 grace 不追跑。
6. DST 重复时间、HMR 和双 DSH 进程不会重复批准同一 candidate。
7. Owner 在 evaluator 返回后手动拒绝 candidate；scheduled commit 重读后跳过，不复活已拒绝项。
8. Provider timeout/invalid schema/cancel 只产生 defer receipt，普通 DSH 会话与现有召回继续工作。
9. 每条自动批准记录可追到 Observation、DSH evaluator Session、Policy Grant revision 和 scheduled run，但审计列表不回显私密正文。
10. 从旧 MistyMoon 路径迁移必须先生成无正文 plan；没有 Owner confirm 时不创建或覆盖新 Archive。

## 待 Owner 决策

1. 原文“CI”是否确指“AI”？若确指 CI，本提案只保留 CI 测试/发布职责，不实现 CI 访问真实记忆。
2. 独立仓库是否继续使用 `@mistymoon/dsh-memory` 名称，还是建立中性品牌？建议先保留包名，拆仓稳定后再讨论改名。
3. scheduled-auto v1 是否接受本文的严格 allowlist（仅 personal preference/biographical），还是希望扩大到 episode/summary？建议第一版不要扩大。
4. 模型 Provider 是否只允许用户已在 DSH 中配置的本地/当前 provider route，并明确展示费用与数据去向？建议是，且失败不 fallback。
5. 独立插件的公开分发 seam 采用哪种 DSH 官方支持方式？应根据生态报告和 rc.7 bundle 文档单独决策，不复用 MistyMoon 已放弃的 npm 用户安装流程。
