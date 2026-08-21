# dsh-Mmem

`dsh-Mmem` 是面向 [DeepSeek Harness（DSH）](https://www.npmjs.com/package/@deepseek-ai/dsh) 的独立长期记忆插件。它把记忆视为需要治理的数据：每条正式记忆都有 Owner、来源、可见性、修订关系和所属 Memory Space；候选记忆默认按本地时区定时自动审批，Owner 也可以显式切换为逐条人工审批。

本插件只使用 DSH 的公开扩展点。DSH 仍然拥有 Agent Runtime、Session、Workspace、工具、权限和模型路由；dsh-Mmem 不修改 DSH 源码，也不创建与 DSH 平行的 Workspace 身份。

> 当前候选版本是 `@mistymoon/dsh-mmem@0.0.1-alpha.2`。完整开发与发行验收基于 DSH `0.1.0-rc.8`；公开 peer range 继续保留此前验证过的 `rc.7`，但本次新增的侧栏与图谱 UI 只在 `rc.8` 完成了完整验证。建议先在中性测试数据或可恢复副本上试用。

## 安装与下载

运行环境：

- Node.js `^22.19.0 || >=24.0.0`
- DSH `>=0.1.0-rc.7 <0.1.0`
- 当前推荐 DSH `0.1.0-rc.8`

普通用户应通过 DSH 插件命令安装已经验收的确切版本：

```powershell
dsh plugin --profile web add @mistymoon/dsh-mmem@0.0.1-alpha.2
```

希望跟随 alpha dist-tag 时可以使用：

```powershell
dsh plugin --profile web add @mistymoon/dsh-mmem@alpha
```

如果只想把 npm 包下载为 `.tgz`、暂不安装：

```powershell
npm pack @mistymoon/dsh-mmem@0.0.1-alpha.2
```

自行维护 Cordis/DSH 组合的集成开发者也可以把它作为依赖安装：

```powershell
npm install @mistymoon/dsh-mmem@0.0.1-alpha.2
```

公开包已经声明 `dsh.bundle.patch`、Host 入口与 Web client discovery；使用 DSH 插件命令时不需要手工修改已安装的包。插件在 Harness 进程中运行，安装前应先审阅本仓库和包内的 `cordis.patch.yml`。

## 首次使用

1. 在 DSH Web 中打开一个属于目标 DSH Workspace 的 live Session。
2. 进入 Memory Settings。若该 Workspace 尚未绑定 Memory Space，页面会直接显示首次设置，不需要刷新会话。
3. 创建一个 Memory Space，或把已有 Space 绑定到当前 Workspace。
4. 选择 Binding 是只读还是读写；需要接收新 Observation/Candidate 时，将一个读写 Space 设为该 Workspace 的 Default Write Space。
5. 审批模式默认是 `scheduled-auto`，使用宿主机 IANA 时区的每日 `03:00`。如需逐条人工审批，Owner 必须在设置中手动选择并保存 `manual`。
6. 轮次摘要默认使用不调用模型的本地快速压缩。Owner 可为当前 Memory Space 显式切换为 DSH 模型压缩，并可选指定已配置的 Provider/Model；留空则使用 DSH 默认路由。

> **审批提示：自动审批默认开启。** 如需人工审批，请由 Owner 在 Memory Settings 中手动切换为“人工审批”并保存。

Workspace 身份只取自 live DSH `SessionHeader.cwd`。浏览器不能自行提交 Owner、`cwd`、任意 Workspace 身份或 Archive 路径。

## 核心能力

- **可追溯治理**：Confirmed Memory 保留 Owner、Memory Kind、可见性、来源消息 ID、时间与 append-only revision lineage；纠正通过新记录替代旧记录，不静默改写历史。
- **临时记忆与候选审核**：每轮结束自动生成带 24 小时 TTL 的摘要 Candidate；默认本地压缩，也可在当前 Memory Space 显式启用已配置 DSH 模型。未过期 Pending 仅在直接进入其 Memory Space 时作为醒目标注的不可靠记忆临时召回，并可按需分页展开该轮用户可见全文。Rejected、Expired 和 Import Draft 不参与召回。
- **记忆浏览器**：侧栏底部的“记忆”按钮打开 Session-bound 浏览器，可在按记忆类型分组的目录视图和语义关系图谱之间切换，并支持搜索与图谱缩放。
- **无需 embedding 的语义关系**：候选审批卡片可用滑块选择是否保存本地可解释规则建议的 `相关` / `矛盾` 关系；关系与正式记忆在同一 Archive 事务内确认，默认不影响召回。
- **安全召回**：默认使用本地 BM25，并在检索前后执行 Owner、authority、scope、有效期、visibility 与 disclosure gate；模型看到的 Recall Snapshot 会写入 DSH Session 日志。
- **多个 Memory Spaces**：每个 Space 使用物理隔离的 Archive；一个 DSH Workspace 可绑定 Space，一个 Space 也可由多个 DSH Workspaces 共用。
- **可治理的跨 Space 召回**：跨空间关系只影响只读召回，不复制记忆、不改变 Source Space，也不授予修改来源记录的权限。
- **本机定时审核**：按用户 IANA 时区和当地时间运行，处理 DST、跨进程 lease 和每日去重；它不依赖 CI/CD 读取用户私有数据。
- **旧数据迁移**：提供从旧 MistyMoon SQLite confirmed rows 到已选定 Space Archive 的显式 plan/apply/rehearse-rollback/rollback 流程。

## Memory Space 与互通模式

Memory Space 是独立治理与召回单元，不等于 Memory Scope，也不等于 DSH Workspace。完整领域词汇见 [`CONTEXT.md`](CONTEXT.md)。

| 模式 | 跨 Space 召回 | 适用场景 |
| --- | --- | --- |
| `isolated` | 不跨 Space；只查询当前 Active Space | 项目、身份或叙事必须完全隔离 |
| `selective` | 仅按显式单向 Grant 读取，并过滤 Memory Kind/visibility；授权不传递 | 只共享某类可控事实 |
| `federated` | 显式 Federation 成员间互相召回；新 Space 不会自动加入 | 多个 Space 需要完整而可审计的共用记忆 |

Borrowed Recall 始终保留 Source Space、授权关系和 policy revision，并与本地结果共同重新应用一次全局数量/字符预算。如果读取期间共享策略发生变化，借用结果会被全部丢弃。

## 审批模式

### `scheduled-auto`

默认模式。首次运行使用宿主机 IANA 时区的每日 `03:00`，Owner 可调整时区和当地时间。插件在本机 DSH Runtime 中集中审核；每个候选都使用 fresh、无 parent/seed、无工具的 DSH Agent Session 生成结构化建议，Memory 治理层在提交前重新校验策略 revision、Owner、Workspace Binding、Space、Candidate、来源、TTL 和冲突。

失败、低置信度、格式异常、`boundary`、`commitment`、阻塞冲突或治理状态变化都会 defer 到人工队列。自动审核不会把 Archive 写权限交给评估模型。

这里的“自动审批”是用户本机的可取消调度任务，不是读取真实 DSH Home 的云端 CI。CI/CD 只运行中性测试、构建和发布审计。

### `manual`

如需逐条人工审批，Owner 必须在 Session-bound Settings UI 中手动选择并保存此模式。候选只能由 Owner 批准、拒绝、编辑或合并；重复/冲突候选要求显式选择 keep-both 或 supersede。

## 数据与安全边界

- Memory Archive、设置、DSH Sessions、日志和凭据位于用户私有 DSH Home，不属于 npm 包，也不应进入 Git。
- 未过期 Pending 只进入 Source Space 的独立 Provisional Recall 分栏，不通过 Selective/Federated/Borrowed Recall 传播；Rejected、Expired、Import Draft、跨 Owner/scope 或未获 disclosure 授权的内容不会进入召回。
- DSH 模型压缩是每个 Memory Space 的显式 opt-in，会增加一次推理、延迟和可能的费用，并将 Source Turn 的用户可见内容交给选定 Provider。超时、非法输出或策略并发变更会回退本地摘要。
- 默认 `local-dsh-host-rpc` authority 面向本机回环、单 Owner Web 部署；其他通道在提供可信 principal Adapter 前失败关闭。
- 外部记忆或高级检索引擎只能作为可替换 Provider；Archive 仍是治理事实来源。

## 当前限制

- 这是 alpha 版本，尚未声明兼容 DSH `rc.9`、后续 rc 或 stable；扩大范围前需要重新跑完整兼容矩阵。
- 自动轮次摘要仍是不可靠 Candidate。模型压缩失败时只回退本地摘要；它不等于细粒度事实抽取。额外抽取 Provider 仍未默认捆绑。
- 默认检索是本地 BM25；PageIndex 和 graph Adapter 默认关闭，远程引擎、embedding 与 reranking 不属于当前基线。
- 当前语义关系建议只使用本地确定性冲突与词法评估，不等同于向量相似度或模型级语义理解。Owner 的显式审批才使关系成为治理事实；`补充` 类型已进入存储和展示协议，但当前本地建议器不会自动判定它。
- 写入首个 `relationship-confirmed` 事件后，旧版插件无法读取新增的 Archive 事件类型；升级前应保留可恢复备份，且不支持直接降级读取该 Archive。
- Lifecycle confirmation plan 是进程内对象，重启后需要依据重放的 Archive 重新创建。
- Standalone migration 支持事务级回滚；已导入批次目前没有业务级“整批撤销”命令，单条记录仍可通过 append-only forget 治理。

## 旧 MistyMoon 数据迁移

迁移不会发现或创建 DSH Workspace/Memory Space。目标 Archive 必须属于用户已经选定的 Space，并应在 DSH 停止写入该 Archive 时操作。`plan` 只输出数量、路径和摘要，不输出记忆内容：

```powershell
pnpm migrate:standalone -- plan <source.sqlite> <target-memories.jsonl> <owner-id> <authority> <scope-json> <memory-kind>
pnpm migrate:standalone -- apply <token> <confirmation> <source-digest> <target-digest>
pnpm migrate:standalone -- rehearse-rollback <rollback-token>
pnpm migrate:standalone -- rollback <rollback-token> <rollback-confirmation>
```

先运行 `rehearse-rollback`；只有结果为 `applicable: true` 时，才应使用返回的 confirmation 执行实际 rollback。首次迁移应使用中性副本演练，不直接操作唯一真实档案。

## 仓库结构

```text
dsh-Mmem/
├─ CONTEXT.md       Memory Space、Scope、Binding 与共享的领域词汇
├─ packages/
│  ├─ memory/       Archive、治理、召回、调度与迁移核心
│  ├─ settings-ui/  Session-bound DSH Settings tab 与 browser bundle
│  └─ bundle/       唯一公开包 @mistymoon/dsh-mmem
├─ scripts/         构建、发布审计与迁移 CLI
├─ cordis.patch.yml 开发组合入口
└─ AGENTS.md
```

内部 workspace 包保持 `private: true`；唯一公开安装面是 `@mistymoon/dsh-mmem`。

## 开发与发布验收

开发环境使用 pnpm `11.7.0`：

```powershell
pnpm install
pnpm check
```

生成并审计唯一可上传 tarball：

```powershell
pnpm pack:npm
```

该命令不会登录或发布 npm。npm 登录、版本、dist-tag、`npm publish` 和 Release 仍由 Owner 手动执行。npm 版本不可重复发布；已经上传的 `0.0.1-alpha.0` 不能用于下一次发布。新预发布版本必须显式指定 tag，例如把下面的 `VERSION` 替换成新版本号：

```powershell
npm publish .\.artifacts\npm\mistymoon-dsh-mmem-VERSION.tgz --tag alpha --access public
```

每个新版本发布后，都应从 registry 包在全新 DSH Home 中重复 clean Profile 验收。

## 问题反馈与许可证

- 问题反馈：[GitHub Issues](https://github.com/mianyoubiaoqing/dsh-Mmem/issues)

本项目使用 MIT License。外部 Provider、模型、二进制与第三方代码保留各自许可证；LivingMemory 是 AGPL-3.0 项目，只作为产品行为参考，其实现不会复制到本 MIT 仓库。
