# dsh-Mmem

`dsh-Mmem` 是一个正在从 MistyMoon 套件拆出的独立 DeepSeek Harness 长期记忆插件工作仓库。目标是提供 Owner 隔离、来源可追溯、可人工审批或按用户时区定时自动审核的治理型记忆，并支持绑定 DSH Workspace、可选择性共享的独立 Memory Spaces，而不是把 Memory 绑定到 RP Persona 或另建 Agent Runtime。

> 当前状态：独立插件 alpha，尚未公开发布，也尚未完成共享策略 Settings UI 与 clean Profile 发行验收。当前 Settings tab 已提供 Session-bound 人工审批与审批策略配置；Owner 显式启用 `scheduled-auto` 后，本机调度器通过 fresh、无工具的 rc.8 Agent Session 生成建议，并在治理重校验后处理低风险候选。旧 SQLite 迁移已提供显式 plan/apply/rollback，但在正式发行验收前仍不要直接迁移真实档案。

## 当前包含

- MistyMoon commit `69ea9809079007ab0bff6abfa58c8cd3483f8044` 中已提交的 Memory 核心、测试和维护脚本。
- Memory 自己拥有的 `MemoryPrincipalResolverV1` Interface 与本地 DSH Host Adapter；旧 `mistymoonOwnerEligibility` 依赖已移除。
- v2 transaction JSONL Archive、lease、checkpoint、quarantine、显式 migration/recovery。
- Owner/authority/scope/visibility/source lineage、候选审核、冲突/supersession、BM25 recall 与 lifecycle。
- Memory Space、DSH Workspace Binding 与完全隔离/有限互通/Federation 内完全互通的领域提案。
- 第一阶段 `MemorySpaceCatalogV1`：版本化 Space、exact DSH `SessionHeader.cwd` Binding、唯一 Default Write、显式 Active Space 与跨进程 lease。
- 第二阶段 `MemorySpaceArchiveRouterV1`：每 Space 独立 Archive、DSH pre-step/tool/candidate 路由、只读写入门与 Source Space/Binding recall receipt。
- 第三阶段 `MemorySpaceGovernanceResolverV1`：Settings Host 只凭 DSH `SessionHeader` 解析 Active Space，Owner 由可信 loopback Adapter 固定；人工审批复用统一治理 facade，只读 Binding 失败关闭，候选不会跨 Space 混列。
- 第四阶段 Memory-owned Host：独立 `@mistymoon/dsh-memory/settings-host` 在 loopback-only RPC channel 上接受 live DSH `sessionId`，由 Host 取得不可变 `SessionHeader`；已支持 Active Space Candidate 的列出、人工批准/拒绝、搜索、来源、冲突评估、编辑、合并和批量治理，浏览器不能提交 `ownerId` 或 `cwd`。
- 第五阶段 Browser RPC client：独立 `@mistymoon/dsh-memory/settings-client` 固定连接 Memory-owned channel，只从 DSH UI 接受 live `sessionId` 与可选已绑定 Space；它校验所有 Host 响应，并为审批、编辑、合并和批量操作生成幂等 request ID。
- 第六阶段 Settings 管理 UI：从 DSH 公共 Session list 读取当前 live Session，展示 exact Active Space、正式记忆、候选及 payload-free 来源/lineage，提供受治理的搜索/筛选、append-only Candidate 编辑/合并、人工批准/拒绝和逐项 partial-success 批量治理；冲突候选必须由 Owner 明确选择 keep-both 或 supersede。无 Session 与只读 Binding 均失败关闭。
- 第七阶段审批策略核心：私有 runtime settings 默认 `manual`；Owner 可用 exact revision 显式切换到带 IANA 时区与 `HH:mm` 本地时间的 `scheduled-auto`，并发陈旧更新失败关闭。此阶段尚未启动调度器或自动审批。
- 第八阶段策略 RPC：Memory-owned settings Manager 与 loopback Settings Host 通过 live Session/Active Space receipt 暴露策略读取和 exact-revision 更新；browser client 不能提交 Owner、Workspace 或 settings path。
- 第九阶段策略 UI：Settings tab 可显式选择 `manual` 或带 IANA 时区和本地时间的 `scheduled-auto`，并用已观察到的 exact revision 保存；只读 Active Space Binding 在 UI 与 Host 两层都失败关闭。
- 第十阶段到期计算：纯 `MemoryApprovalScheduleV1` Module 给出最近已到期和下一当地日期槽位；DST 缺失时间顺延到第一个有效时刻，重复时间取第一次。此阶段仍不启动调度副作用。
- 第十一阶段本机调度生命周期：首次观察策略只武装下一槽位；跨进程 lease 覆盖 runner 执行，90 条 payload-free receipt 防止同一当地日期重复运行，策略 revision 在返回后重读，Cordis disposer 会取消在途 runner。没有 runner 时保持武装且不写 receipt。
- 第十二阶段治理型自动审核 runner：只接受带 DSH Session receipt 的结构化建议；在提交前重读 exact policy revision、trusted Owner、DSH Workspace Binding revision、Space、Candidate 完整快照、来源与 deterministic conflict。低置信度、失败、`boundary`、`commitment` 和阻塞冲突均 defer。当前尚未提供实际创建 rc.8 Agent Session 的 Evaluator Adapter。
- 第十三阶段 rc.8 DSH Session Evaluator：每个候选使用 fresh、无 seed/parent 的 Agent Session；complete system prompt、runtime-context suppression、空工具 catalog 与执行 guard 共同封闭能力面。候选和严格 JSON 输出进入 DSH 日志，只有 `ctx.sessions.flush()` 确认存在 durability listener 后才返回 exact event receipt。Provider/model 可留空以沿用 DSH 默认路由，也可在插件配置中固定。
- 第十四阶段独立迁移事务：旧 MistyMoon SQLite confirmed rows 先形成 content-free logical digest plan；apply 要求 exact Owner confirmation、source/target digest，并在目标 Archive lease 内备份原 generation、导入临时 generation 后原子发布。结果携带 rollback token；rehearsal 与实际 rollback 都拒绝目标或备份漂移。
- 第十五阶段 Space sharing catalog：单独的版本化目录以 exact revision 保存 Owner 的 `isolated`、`selective` 或 `federated` 模式。Selective Grant 是带 Memory Kind/visibility 过滤的单向、只读、非传递授权；Federation 只包含显式成员，且一个 Space 最多属于一个 Federation。解析器只返回 Active Space 的直接授权 Source Space 与 policy receipt，不改变 DSH Workspace Binding 或记忆归属。
- 第十六阶段 Borrowed Recall：Workspace Binding 仍只选择一个 Active Space；Router 依据 sharing catalog 从物理隔离的 Source Archive 执行只读召回，在 Archive 原有 Owner/scope/disclosure gate 后应用 Grant 过滤，然后对本地与借用结果重新执行一次全局数量/字符预算。每条借用结果携带 Source Space、relation 与 policy revision；策略在读取期间变化时丢弃全部借用结果，借用 ID 不能通过 Active Space facade 修改。
- npm 发布边界：内部 workspace 包继续私有；唯一安装包 `@mistymoon/dsh-mmem` 聚合 Memory、本地 principal Adapter、Settings Host 和 Settings UI，并声明官方 DSH bundle patch。

## 目录

```text
dsh-Mmem/
├─ CONTEXT.md      Memory Space、Scope、Binding 与共享的统一领域词汇
├─ packages/
│  ├─ memory/       当前 Memory implementation 迁移基线
│  ├─ settings-ui/  Session-bound DSH Settings tab 与 browser bundle
│  └─ bundle/       唯一可发布的 `@mistymoon/dsh-mmem` npm 包
├─ scripts/         maintenance 与旧数据 migration CLI
├─ cordis.patch.yml 开发组合草案
└─ AGENTS.md
```

## 目标审批模式

- `manual`：默认；候选只由 Owner 审核。
- `scheduled-auto`：Owner 显式选择时区与本地时间后，插件在本机 DSH Runtime 中集中审核低风险候选。

CI/CD 只负责中性测试、构建和发布审计，绝不访问真实用户记忆。若模型参与审核，它只返回不可信结构化建议；Memory 在提交前重新校验 Owner、scope、来源、冲突、策略 revision 与 Archive generation。

Memory Space、Scope、Binding 与共享术语以 `CONTEXT.md` 为准。DSH 是 Workspace 身份与生命周期的唯一权威；dsh-Mmem 不创建平行的 Workspace 标识。这里的 `Memory Space` 表示独立治理/召回空间，`Memory Scope` 仍只表示事实属于哪个现实或叙事范围，三者不会合并。

## 开发

环境基线：Node.js `^22.19.0 || >=24.0.0`、pnpm `11.7.0`、DSH `0.1.0-rc.8`。公开 peer range 同时保留已验证的 `rc.7`。

```powershell
pnpm install
pnpm check
```

`cordis.patch.yml` 与公开包中的 bundle patch 都只引用 `@mistymoon/dsh-mmem` 及其子入口。运行以下命令会构建、审计、执行临时 clean install，并把唯一可上传的 tarball 留在 `.artifacts/npm/`：

```powershell
pnpm pack:npm
```

该命令不会登录或发布 npm。最终 `npm publish <tgz> --access public`、dist-tag 和版本选择只由 Owner 手动执行。当前仍需在公开发布前完成 clean DSH Profile UI smoke、许可证复核与发行验收。

旧 SQLite 到一个已经选定的 Memory Space Archive 的迁移使用四步 CLI。`plan` 只输出数量、路径和摘要，不输出记忆内容；把其返回的 token、confirmation 和 digest 原样传给 `apply`。迁移后先运行 `rehearse-rollback`，只有报告 `applicable: true` 时才可用结果中的 confirmation 执行 `rollback`：

```powershell
pnpm migrate:standalone -- plan <source.sqlite> <target-memories.jsonl> <owner-id> <authority> <scope-json> <memory-kind>
pnpm migrate:standalone -- apply <token> <confirmation> <source-digest> <target-digest>
pnpm migrate:standalone -- rehearse-rollback <rollback-token>
pnpm migrate:standalone -- rollback <rollback-token> <rollback-confirmation>
```

这些命令不创建 DSH Workspace 或 Memory Space；目标路径必须来自 Owner 已选定的 Space。迁移应在 DSH 停止写入该 Archive 时运行。

## 下一步

1. 用统一 `GovernedMemoryV1` Interface 深化 Archive/governance/recall Module。
2. 把已完成的 Space sharing catalog 与 Borrowed Recall 接入 Session-bound Settings Host/client/UI。
3. 完成 clean DSH Profile UI smoke、许可证复核与发行验收后，再由 Owner 手动上传 npm tarball。

## 许可证

本迁移基线沿用 MIT License。外部 Provider、模型、二进制与第三方代码保留各自许可证；LivingMemory 为 AGPL-3.0，只能作为产品行为参考，不能复制实现到本 MIT 仓库。
