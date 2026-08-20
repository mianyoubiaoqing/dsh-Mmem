# dsh-Mmem Agent 协作约定

本仓库用于把 MistyMoon 的 Memory 能力演化为独立 DeepSeek Harness（DSH）插件。修改前必须阅读本文件、`README.md`、`docs/standalone-plugin-proposal.md` 与受影响包的说明。

## 产品不变量

- DSH 拥有 Agent Runtime、Session、工具、权限、模型路由与 Web Host；本插件只使用 DSH 公开扩展点。
- DSH 拥有 Workspace 的身份与生命周期；本插件只把 Memory Space 绑定到 DSH 提供的 Workspace，不创建平行的 Workspace 标识或路径规则。
- Memory 拥有 Observation、Candidate、Confirmed Memory、revision、Archive、治理策略、召回与审计；Persona/RP 不是本仓库职责。
- pending、rejected、import draft、跨 Owner/scope 或未获披露授权的内容不得进入召回。
- 模型可见 Recall Snapshot 与 AI review 必须能从 DSH Session 日志重建。
- 默认审批模式是人工。任何定时自动审批都必须由 Owner 显式开启、可撤销、失败关闭并保留来源与策略 revision。
- CI/CD 不读取或修改真实用户 Memory、DSH Home、Session 或凭据；凌晨批处理运行在用户本机 DSH Runtime 内。

## 隐私与发布

- 不读取、复制、提交或回显真实 Persona、Memory、DSH Home、会话、日志、凭据、迁移数据库或诊断转储。
- 测试只使用中性生成数据和系统临时目录。
- 未经 Owner 明确授权，不 commit、push、创建 Release、发布 npm 包、迁移真实档案或启用远端 Provider。
- 发布前必须完成许可证、第三方资产、构建产物和隐私审计。

## TypeScript 与 DSH

- 使用 ESM、严格 TypeScript、包名导入；本地相对导入保留 `.js` 后缀。
- 公共导出和非直观约束需要简洁 JSDoc；不可信 JSON/JSONL、配置、工具参数、Provider 输出和进程输出必须校验。
- Cordis 生命周期副作用使用 `ctx.effect()`、`ctx.on()` 或返回 disposer 的注册接口。
- Waterfall listener 必须调用 `next()`，除非明确且有测试地终止流程。
- 存储格式带版本；破坏性变更必须有显式 plan/apply、备份和回滚演练。
- Windows 进程只停止自己启动并记录句柄的进程。

## 工作流

1. 先运行 `git status --short` 并保留已有改动。
2. 先写能复现行为的测试，再实现变更。
3. 让 DSH tools、Settings Host、CLI 与 tests 穿过同一个 Governed Memory Interface，避免复制治理规则。
4. 先运行定向测试，交付前运行 `pnpm check`。
5. 只报告实际执行过的命令和仍存在的限制。

## Git

- 分支默认使用 `codex/` 前缀。
- 不使用 `git reset --hard`、`git clean` 或覆盖用户改动的命令。
- 未经明确授权不提交、不推送、不发布。
