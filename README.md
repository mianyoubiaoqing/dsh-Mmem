# dsh-Mmem

`dsh-Mmem` 是一个正在从 MistyMoon 套件拆出的独立 DeepSeek Harness 长期记忆插件工作仓库。目标是提供 Owner 隔离、来源可追溯、可人工审批或按用户时区定时自动审核的治理型记忆，并支持绑定 DSH Workspace、可选择性共享的独立 Memory Spaces，而不是把 Memory 绑定到 RP Persona 或另建 Agent Runtime。

> 当前状态：迁移基线，尚未公开发布，也尚未完成独立 Settings UI、通用身份 Adapter 和定时 AI 审批。不要把此目录直接用于真实档案迁移。

## 当前包含

- MistyMoon commit `69ea9809079007ab0bff6abfa58c8cd3483f8044` 中已提交的 Memory 核心、测试和维护脚本。
- 当前测试暂需的 Owner Eligibility 实现，后续会替换为 Memory 自己拥有的 `MemoryPrincipalResolver` Interface 与 loopback/MistyMoon Adapters。
- v2 transaction JSONL Archive、lease、checkpoint、quarantine、显式 migration/recovery。
- Owner/authority/scope/visibility/source lineage、候选审核、冲突/supersession、BM25 recall 与 lifecycle。
- 独立插件/定时审批提案与 2026-08-21 DSH 记忆生态调研。
- Memory Space、DSH Workspace Binding 与完全隔离/有限互通/Federation 内完全互通的领域提案。
- 第一阶段 `MemorySpaceCatalogV1`：版本化 Space、exact DSH `SessionHeader.cwd` Binding、唯一 Default Write、显式 Active Space 与跨进程 lease。

## 目录

```text
dsh-Mmem/
├─ CONTEXT.md      Memory Space、Scope、Binding 与共享的统一领域词汇
├─ packages/
│  ├─ memory/       当前 Memory implementation 迁移基线
│  └─ identity/     临时 Owner Eligibility 兼容实现
├─ scripts/         maintenance 与旧数据 migration CLI
├─ docs/
│  ├─ standalone-plugin-proposal.md
│  ├─ memory-space-sharing.md
│  └─ research/dsh-memory-plugin-ecosystem-2026-08-21.md
├─ cordis.patch.yml 开发组合草案
└─ AGENTS.md
```

## 目标审批模式

- `manual`：默认；候选只由 Owner 审核。
- `scheduled-auto`：Owner 显式选择时区与本地时间后，插件在本机 DSH Runtime 中集中审核低风险候选。

CI/CD 只负责中性测试、构建和发布审计，绝不访问真实用户记忆。若模型参与审核，它只返回不可信结构化建议；Memory 在提交前重新校验 Owner、scope、来源、冲突、策略 revision 与 Archive generation。

详细设计见 [独立插件提案](docs/standalone-plugin-proposal.md)，竞品与市场判断见 [生态调研](docs/research/dsh-memory-plugin-ecosystem-2026-08-21.md)。

Memory Space 设计见 [DSH Workspace 绑定与跨空间共享提案](docs/memory-space-sharing.md)。DSH 是 Workspace 身份与生命周期的唯一权威；dsh-Mmem 不创建 `Workspace Reference`。这里的 `Memory Space` 表示独立治理/召回空间；现有 `Memory Scope` 仍只表示事实属于哪个现实或叙事范围，三者不会合并。

## 开发

环境基线：Node.js `^22.19.0 || >=24.0.0`、pnpm `11.7.0`、DSH `0.1.0-rc.7`。

```powershell
pnpm install
pnpm check
```

当前 `cordis.patch.yml` 是开发组合草案：它仍同时加载临时 identity 与 Memory workspace 包。公开安装前必须完成单包 bundle/exports、独立 Settings client、clean-profile smoke 和发布审计。

## 下一步

1. 用统一 `GovernedMemoryV1` Interface 深化 Archive/governance/recall Module。
2. 用 `MemoryPrincipalResolver` 解除 `mistymoonOwnerEligibility` 字符串依赖。
3. 从 MistyMoon Settings UI 提取 Memory-owned Host/client。
4. 先发布默认人工审批的独立 MVP，再实现 `scheduled-auto`。
5. 提供旧 `mistymoon/memory` 到新独立目录的只读 plan、exact digest、备份、Owner confirm、apply 与 rollback rehearsal。
6. 把已完成的 Memory Space Catalog/DSH Workspace Binding 接入 DSH Runtime，再分阶段实现物理隔离、非传递的有限共享和显式 Federation。

## 许可证

本迁移基线沿用 MIT License。外部 Provider、模型、二进制与第三方代码保留各自许可证；LivingMemory 为 AGPL-3.0，只能作为产品行为参考，不能复制实现到本 MIT 仓库。
