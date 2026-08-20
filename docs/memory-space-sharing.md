# Memory Space、DSH Workspace 绑定与跨空间共享提案

状态：领域与产品提案；阶段 1 Space Catalog/DSH Workspace Binding seam 已实现，尚未接入 Archive 路由；不授权迁移真实档案或启用跨空间召回。

基线：`dsh-Mmem` 迁移仓库，DSH `0.1.0-rc.7`，2026-08-21。

## 结论

值得做，但“支持多个分区”本身不是强差异化。`dsh-mnemon` 已有 global/workspace/custom Memory Spaces，`dsh-memento` 已有 user-global/workspace tracks，MemOS 也有可组合的 memory cube。真正有辨识度的是把以下能力组合成一个可治理的空间网络：

1. 一个 Memory Space 可绑定一个或多个 DSH Workspace；一个 DSH Workspace 也可挂载多个 Space。
2. 每条记忆只属于一个 Source Space，不因共享而复制、移动或失去来源。
3. Owner 可选择完全隔离、显式有限互通，或在明确 Federation 内完全互通。
4. 有限互通是单向、只读、不可传递且带稳定过滤条件的 Grant。
5. Recall Snapshot 记录命中的 Source Space、Workspace Binding、Share Grant/Federation revision 与选择理由。
6. 审批、纠正、替代、遗忘和永久删除始终回到 Source Space 执行，借用方不能改写来源。
7. 每个 Space 可独立配置人工或定时自动审批、备份、导出、Provider 和生命周期策略。

这可以把定位从“有 workspace scope 的记忆插件”提升为：

> Governed memory spaces for DSH — bind many workspaces, share selectively, and preserve source ownership.

## 与 DSH Workspace 统一

`DSH Workspace` 是本提案唯一的 Workspace 概念。dsh-Mmem 不拥有 Workspace 的创建、选择、路径规范、重命名或删除，也不定义 `Workspace Reference`、插件 Workspace ID 或通过项目名猜测 Workspace。

在 DSH `0.1.0-rc.7` 中，CLI 把启动目录作为默认 workspace root，Session 则把创建时经过校验的绝对 `cwd` 持久化在不可变 `SessionHeader`。当前公开类型没有独立稳定的 `WorkspaceId`，因此 rc.7 Adapter 只能把 DSH Session 提供的 exact `header.cwd` 当作 Workspace 绑定键：

- 多个 Session 的 exact DSH `cwd` 相同，即属于同一个 DSH Workspace 绑定；
- `cwd` 缺失时不自动绑定、不自动写入、不召回 Workspace Memory；
- dsh-Mmem 不自行 `realpath`、hash、按仓库名合并或从模型文本推断 Workspace；
- DSH Workspace 移动后出现新的 DSH `cwd` 时，由 Owner 显式重新绑定，Memory Space 与其中记忆不自动移动；
- 若未来 DSH 公布稳定 Workspace ID，必须通过版本化迁移把旧 `cwd` Binding 转换过去，不能静默双轨识别。

Settings UI 只能消费 DSH Host 提供或从 DSH Session 证据确认的 Workspace；任意路径输入不能凭空创建一个 DSH Workspace。这个决定记录在 [ADR 0001](adr/0001-dsh-owns-workspace-identity.md)。

## 当前模型为什么不能直接承载

现有 `MemoryScopeV1` 只有 `companion-reality`、`character-scene` 和 `campaign-branch`，表示事实在哪个现实/虚构范围成立；Archive 和召回采用 exact Owner + authority + scope equality。DSH Adapter 目前还把普通请求硬编码到 Companion Reality。

Memory Space 是另一条正交轴：

```text
Memory identity = Owner × Source Space × Memory Scope × Observation source
Access decision = DSH Workspace Binding + Inter-Space Mode + Share Grant/Federation
Disclosure     = visibility + channel policy + current request intent
```

不能把 Space 塞进现有 `scope.kind`，否则“Client-A DSH Workspace 的现实事实”和“Client-B DSH Workspace 的现实事实”会共享同一个 Companion Reality scope，或者被迫发明大量项目型 scope kind。也不能把 DSH Workspace 的 `cwd` 当 space ID；一个 Space 需要跨多个 DSH Workspace 共享，Workspace 绑定变化也不应改变记忆归属。

现有 `MemoryKind` 也明显偏向陪伴/RP，只包含 preference、biographical、boundary、commitment、relationship、episode、state、summary。独立插件面向工程 DSH Workspace 前，需要另行定义向后兼容的通用 Kind，例如 fact、decision、constraint、procedure；否则“有限互通只分享工程决策/流程”无法用稳定字段表达。这个 Kind 演化必须是独立 Spec，不能夹在 Space 存储迁移里。

## 关系模型

```text
Owner
 ├─ owns ─> Memory Space A ── contains ─> Memory Records
 ├─ owns ─> Memory Space B ── contains ─> Memory Records
 └─ owns ─> Memory Space C ── contains ─> Memory Records

DSH Workspace 1 ── read-write/default ─> Space A
DSH Workspace 2 ── read-write/default ─> Space A
DSH Workspace 2 ── read-only ─────────> Space B

Space A ── filtered read grant ──> Space B
Space C ── no grant ─────────────> isolated
```

关系约束：

- Memory Record、Candidate 和 Observation 各有且只有一个 Source Space。
- DSH Workspace 与 Space 是多对多关系。
- 每个 DSH Workspace 至多一个 Default Write Space；没有 Default 时自动抽取保持 disabled/deferred，不猜测目标。
- 一个 DSH Workspace 可以对多个 Space 有 read binding，但一个 DSH Session 同时只有一个 Active Space；Binding 只授予可选择性，不等于同时召回所有绑定 Space。
- Session 未显式选择时使用其 DSH Workspace 的 Default Write Space 作为 Active Space；模型工具参数不能自行添加 binding 或选择未授权 Space。
- Binding 解除不会删除 Space 或记忆；Space 删除仍是单独的高风险 Owner 操作。

## 三种互通模式

### 1. 完全不互通：`isolated`

- Recall 只查询当前 Session 的 Active Space；同一 DSH Workspace 绑定的其他 Space 也不会隐式加入。
- 所有 Space Share Grant 与 Federation 暂停生效，但配置保留，便于 Owner 恢复。
- 多个 DSH Workspace 可分别把同一个 Space 选为 Active Space，从而共享这一份权威记忆；这不是跨空间互通。

这是默认模式。

### 2. 有限互通：`selective`

Owner 创建明确的单向 `Space Share Grant`。含义采用“Source Space 允许 Target Space 在召回时读取”，例如：

```text
Engineering Standards ── personal decision/procedure ──> Project Alpha
```

v1 建议只支持可解释的稳定过滤条件：

- Memory Kind allowlist；
- Memory Scope allowlist；
- visibility 上限，默认只允许 `personal`；
- 来源 DSH Workspace allowlist；
- 是否允许 archived/cold tier，默认不允许 archived。

不要在 v1 使用模型生成 topic、embedding 相似度或自然语言 policy 决定访问权。检索相关性只能在 Grant 已确定允许的数据集合内排序，不能反向扩大 Grant。

Grant 必须满足：

- 单向：A→B 不意味着 B→A；
- 不传递：A→B 且 B→C 不意味着 A→C；
- 只读：B 不能批准、纠正、替代、遗忘或移动 A 的记录；
- 不再分享：Borrowed Recall 不能作为 B 的来源继续传播；
- 可撤销：撤销后下一次请求立即停止召回，历史 DSH Snapshot 仍保留当时实际可见内容。

### 3. 完全互通：`federated`

“完全”只适用于 Owner 明确创建并列出成员的 `Space Federation`，绝不意味着所有现有和未来 Space 自动全局互通。

- Federation 内成员互相召回所有通过强制 Owner、Memory Scope、status、validity、visibility 与 channel disclosure gate 的记录。
- `confidential` 仍要求可信通道允许且当前 Owner 明确请求；Federated 不能覆盖这一双门。
- 新 Space 默认不加入 Federation；成员变化产生新 revision 并显示影响预览。
- 一个 Space 首版最多属于一个 Federation，避免重叠组导致难以解释的传递可达性。

设置 UI 可以显示“完全互通”，但保存前必须列出实际成员、预计可新增读取的 Space 和 confidential 不会被自动放开的说明。

## 写入与审批

跨空间能力不能让写入目标变得含糊：

1. DSH Host 从当前 Session 的 durable `header.cwd` 取得当前 DSH Workspace；缺失时 fail closed。
2. DSH Session 只从该 DSH Workspace 的有效 Binding 选择一个 Active Space；缺省为其 Default Write Space。
3. 显式 `remember` 与自动抽取都只写 Active Space；Active Space 为 read-only 或不存在时保持 disabled/deferred。
4. 若 Owner 想把同一事实放入另一个 Space，应创建带原始 Observation lineage 的新 Candidate；不能静默移动或复制 confirmed record。
5. Candidate 只由 Source Space 的审批策略处理。

建议让审批策略属于 Space：

- 私人 scratch Space 可以使用凌晨 `scheduled-auto`；
- 多 DSH Workspace 共用的团队/标准 Space 可以强制 `manual`；
- `confidential` 和冲突候选仍由全局强制规则 defer 给人工。

这样“空间治理 + 定时审批”会比单独两个功能更有产品差异。

## 召回计划

每次 Recall 先生成一个无正文、可解释的 `Space Access Plan`：

```text
Current DSH Workspace
  -> validate one Active Space against DSH Workspace Bindings
  -> apply Inter-Space Mode
  -> expand exact Grants or Federation membership
  -> enforce Owner/scope/visibility/status gates per Source Space
  -> query each allowed Space independently
  -> Archive backcheck in each Source Space
  -> merge/rerank with local-before-borrowed preference
  -> persist exact model-visible Recall Snapshot + access receipts
```

关键规则：

- 不建立绕过 access plan 的全局正文索引。派生索引按 Space 隔离，跨空间查询在授权后 fan-out。
- Provider 只看到已通过 Space 与 disclosure gate 的 projection，并只返回 ID/score/reason。
- Borrowed Recall 必须标记 Source Space；模型不能把它描述成当前 DSH Workspace 自己确认的事实。
- 不同 Space 出现冲突时不自动 supersede。Snapshot 同时保留来源并产生 `cross-space-conflict` reason，默认让当前 DSH Workspace 的 Active Space 排在 borrowed Space 前。
- 预算同时限制总字符数、Space 数量和每 Space 结果数，避免 Federation 放大模型上下文与成本。

## 存储建议

为兑现“独立隔离”，建议采用每 Space 一个 Archive，而不是仅在同一 JSONL 中增加 `spaceId` 逻辑过滤：

```text
dsh-mmem/
├─ catalog.json                 # Space、DSH Workspace Binding、Grant、Federation revision
└─ spaces/
   ├─ <space-id-a>/memories.jsonl
   ├─ <space-id-b>/memories.jsonl
   └─ <space-id-c>/memories.jsonl
```

优点：

- 独立备份、导出、quarantine、容量限制和删除计划；
- 单 Space 损坏不会阻断其他 Space；
- 物理隔离与 UI 中“独立空间”的心智一致；
- Provider/index 可以按 Space 重建，不依赖全局过滤正确性。

代价：

- 跨空间 Recall 需要多 Archive fan-out、取消和预算；
- catalog 与 Archive 之间需要明确 revision/lease 语义；
- 跨 Space 搬迁不能伪装成单文件内 update，应是显式 plan/apply。

这个取舍较难逆转，实施前应在 prototype 中验证 50–100 个 Space 的 Windows 文件句柄、启动时间和并行 BM25 延迟，再形成 ADR。

## 设置体验

建议设置页包含：

1. **Spaces**：名称、说明、绑定 DSH Workspace、Default Write、审批模式、档案健康和大小。
2. **DSH Workspace matrix**：由 DSH 证据确认的 Workspace × Space 的 none/read/read-write/default 关系。
3. **Inter-space master mode**：完全不互通 / 有限互通 / Federation 内完全互通。
4. **Selective grants**：以有向边显示 Source→Target 和过滤条件；反向必须单独创建。
5. **Federations**：明确成员列表，不提供“自动加入未来 Space”。
6. **Access preview**：选择一个 DSH Workspace 与查询，只显示将访问哪些 Space、依据哪个 binding/grant/revision，不读取真实正文也能预览。
7. **Recall receipt**：实际结果按 local/borrowed、Source Space 与原因分组。

“有限互通”如果没有可视化和 preview，会成为高级用户才敢碰的危险配置；UX 是该差异能否被用户感知的核心，而不是附属页面。

## 场景压力测试

### 场景 A：多个代码仓共用工程标准

Frontend、Backend、Infrastructure 三个 DSH Workspace 共同读写 `Engineering Standards` Space，各自另有一个项目 Space。标准 Space 强制人工审批；项目 Space 可凌晨自动审批。修改标准只产生一份权威记录，三个 DSH Workspace 下一次 Recall 都引用相同 Source Space。

### 场景 B：两个客户完全隔离

Client A 与 Client B 各自只有独立 Space，master mode 为 `isolated`。即使 query 文本高度相似、Provider 返回错误 ID 或模型声称需要参考另一个客户，Archive backcheck 也必须产生零跨 Space 结果。

### 场景 C：有限共享通用经验

Personal Engineering Space 只把 `procedure` / `decision` 类 personal 记录单向分享给 Project A；Project A 的客户事实不反向进入 Personal Space。Project A 再分享给 Project B 时，Personal 记录不能沿 A→B 传递。

### 场景 D：完全互通但保密仍封闭

Owner 把三个个人项目 Space 加入一个 Federation。普通 confirmed 记录可互相召回；confidential 记录仍只有在可信通道和 Owner 明确 confidential recall intent 同时成立时可见。

### 场景 E：同一 DSH Workspace 挂载多个 Space

DSH Workspace X 对 Project X Space 是 default read-write，对 Engineering Standards 是 read-only。普通 Session 的 Active Space 为 Project X，自动 Candidate 只能进入 Project X；Owner 可以显式切换到 Standards 做只读查询，但模型不能因为标准更相关而自行切换或写进 read-only Space。

### 场景 F：跨空间冲突

Space A 记录“部署必须使用蓝绿策略”，Space B 记录“该遗留系统只能停机发布”。Federated Recall 可同时呈现并标注来源，不能自动将一个 supersede 另一个；冲突可能是不同项目上下文，而非事实错误。

## 差异化判断

### 不是差异化的部分

- global/workspace/custom scope；
- 多个 Memory Space；
- DSH Workspace 级隔离；
- 本地存储或 Web 管理页。

这些已被 [`dsh-mnemon`](https://github.com/omdsh-dev/dsh-mnemon)、[`dsh-memento`](https://github.com/PerryLink/dsh-memento) 和 [MemOS](https://github.com/MemTensor/MemOS) 部分覆盖。

### 可以形成差异的组合

- many-to-many DSH Workspace Binding + 唯一 Default Write Space；
- 每 Session 唯一 Active Space，避免多 Binding 在隔离模式下隐式合流；
- 非传递的有向有限共享；
- 明确 Federation，而非隐式 global；
- 每条 Borrowed Recall 保留 Source Space、Grant revision 与 DSH 日志；
- 每 Space 独立 Archive、审批、备份、Provider 和生命周期；
- 跨空间冲突不篡改来源事实；
- 与 manual / scheduled-auto 治理共用同一个不可绕过的 Memory Module。

我的判断：单独推出“分区开关”只能带来轻度差异；把它实现为 **Governed Memory Space Federation**，并提供安全默认值、图形化授权和可解释 Recall receipt，会成为较强差异，尤其适合多仓工程、多个客户、多个 RP 世界和个人/团队知识隔离用户。它仍不是不可复制的技术护城河，真正的护城河来自迁移可靠性、零泄漏验证、设置体验和公开 benchmark。

## 分阶段实施

1. **Space Catalog（seam 已完成）**：已增加 Space/DSH Workspace Binding/Default Write 的版本化模型、中性 tests、跨进程 lease 与 exact DSH `SessionHeader.cwd` 适配；尚未接入 Archive/Recall。
2. **Physical Isolation**：每 Space Archive、独立 health/backup/quarantine；把现有 v2 Archive 显式迁入 Owner 选择的 default Space。
3. **Shared Space**：允许多个 DSH Workspace 直接绑定同一个 Space，不做跨 Space 扩展。
4. **Selective Grants**：单向、过滤、非传递、只读，先做 access plan/preview 再接真实 recall。
5. **Federation**：显式成员、完整 receipts、budget 与 cross-space conflict 行为。
6. **Per-Space Approval**：manual / scheduled-auto 与 Space policy 结合。
7. **Evaluation**：跨 Space leakage、grant revocation、confidential gate、冲突、Windows 多 Archive 性能和 DSH 日志重建。

不要把 Archive v3、Settings UI、跨空间检索、迁移和自动审批放进同一个提交或版本。

## 验收底线

- 默认 `isolated`，新 Space 不自动绑定、新 Federation 不自动吸收未来 Space。
- 一个 Session 没有一个经 Binding 授权且可写的 Active Space 时不自动写入。
- A→B、B→C 永不产生 A→C 的隐式可达性。
- `federated` 永不覆盖 Owner、Memory Scope、visibility、status、validity 或 confidential disclosure gate。
- Borrowed Recall 永不成为目标 Space 的新来源，除非 Owner 显式创建带 lineage 的 Candidate。
- 撤销 binding/grant 后下一请求立即停止召回，且历史 Snapshot 仍可重建。
- Provider 返回越权 ID 时 Archive backcheck 丢弃并记录 leakage receipt。
- Space 迁移、删除、合并和拆分都必须 plan/apply，不能根据正文猜测。
