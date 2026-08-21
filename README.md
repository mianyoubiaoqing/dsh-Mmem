# dsh-Mmem

`dsh-Mmem` 是一个正在从 MistyMoon 套件拆出的独立 DeepSeek Harness 长期记忆插件工作仓库。目标是提供 Owner 隔离、来源可追溯、可人工审批或按用户时区定时自动审核的治理型记忆，并支持绑定 DSH Workspace、可选择性共享的独立 Memory Spaces，而不是把 Memory 绑定到 RP Persona 或另建 Agent Runtime。

> 当前状态：迁移基线，尚未公开发布，也尚未完成通用身份 Adapter、完整管理型 Settings UI 和定时 AI 审批。当前 Settings tab 已提供 Session-bound 人工候选审批 MVP；不要把此目录直接用于真实档案迁移。

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

## 下一步

1. 用统一 `GovernedMemoryV1` Interface 深化 Archive/governance/recall Module。
2. 在已完成管理能力的 Session-bound Settings UI 上增加策略与调度配置，但不复制治理业务规则。
3. 先发布默认人工审批的独立 MVP，再实现 `scheduled-auto`。
4. 提供旧 `mistymoon/memory` 到新独立目录的只读 plan、exact digest、备份、Owner confirm、apply 与 rollback rehearsal。
5. 在已完成的 Catalog、物理隔离、Runtime 路由和 Space-aware Settings governance 上，分阶段实现非传递的有限共享和显式 Federation。

## 许可证

本迁移基线沿用 MIT License。外部 Provider、模型、二进制与第三方代码保留各自许可证；LivingMemory 为 AGPL-3.0，只能作为产品行为参考，不能复制实现到本 MIT 仓库。
