# `@mistymoon/dsh-mmem` 0.0.1-alpha.0 发行验收

> 验收日期：2026-08-21  
> npm 边界：只生成 tarball；登录、token、`npm publish`、dist-tag 与 Release 由 Owner 手动执行。

## DSH 兼容性

| DSH 版本 | 声明 | 实际证据 |
|---|---|---|
| `0.1.0-rc.8` | 完整开发与发行基线 | typecheck、全部测试、build、built smoke、packed clean-install smoke、官方 npm CLI clean Profile Web UI smoke |
| `0.1.0-rc.7` | 保留兼容 | 既有开发基线；官方 npm CLI 独立 clean Profile 安装、Web 启动与 Memory Settings tab smoke |

公开 peer range 保持 `>=0.1.0-rc.7 <0.1.0`。没有把未验证的 `0.1.0` stable 或后续 rc 纳入声明。

rc.8 浏览器入口需要公开包根级 `exports["./client"]` 与 `dsh.client` manifest。本次 clean Profile 首轮发现 Settings tab 未被扫描，补齐根入口、依赖声明和 package module ID 后复测通过。

## 官方 rc.8 clean Profile UI smoke

使用 registry 中已构建的 `@deepseek-ai/dsh@0.1.0-rc.8`，而非本地 DSH 源码 checkout。临时 Profile 和 Memory 数据均位于仓库忽略的 `.tmp/`，只使用中性生成数据。

已验证：

- 本地 tarball 能作为 Web Profile bundle 加载；
- `dsh-Mmem 记忆` 出现在 rc.8 的插件设置 tab；
- 无 live Session 时显示失败关闭提示；
- 打开带真实 `SessionHeader.cwd` 的 live Session；
- 首次设置列出当前 Workspace 状态；
- 创建 `Smoke Space`；
- 将其以 read-write + default-write 绑定到当前 DSH Workspace；
- 进入 Active Space 管理面；
- approval editor 显示 `manual` / `scheduled-auto`，定时模式显示 `Asia/Shanghai` / `03:00`；
- sharing editor 显示 `isolated` / `selective` / `federated`；
- 浏览器 console 与 DSH stderr 无错误或 warning。

另用 registry 的 `@deepseek-ai/dsh@0.1.0-rc.7` 创建独立 clean Profile，验证 tarball 安装、Web 启动、根 `dsh.client` 发现和 Memory Settings tab 显示；console 与 stderr 无错误。测试后已关闭两个 Playwright 会话，并只停止本轮启动且核对命令行的 DSH PID。

## tarball 内容与隐私

产物：`.artifacts/npm/mistymoon-dsh-mmem-0.0.1-alpha.0.tgz`，165,219 bytes，SHA-256 `2EB705D6741E9B857B9AFFB982CFFA25EC4E2663C6C9A85C9FB9696CE9D259E1`。

允许内容仅为：

- `lib/memory/**`；
- `lib/settings-ui/**`；
- `cordis.patch.yml`；
- `package.json`、`README.md`、`LICENSE`。

publication smoke 拒绝 tests、docs、private、data、coverage、`.env`、日志、JSONL、SQLite、tgz 嵌套文件和任意未列出的路径。Memory Archive、设置、DSH Sessions、日志和凭据不进入包。

## 许可证复核

实际 clean-install runtime tree：

| 包 | 版本 | 许可证 |
|---|---:|---|
| `@deepseek-ai/schemastery` | 3.18.1 | MIT |
| `@deepseek-ai/cosmokit` | 1.8.2 | MIT |
| `@standard-schema/spec` | 1.1.0 | MIT |
| `proper-lockfile` | 4.1.2 | MIT |
| `graceful-fs` | 4.2.11 | ISC |
| `retry` | 0.12.0 | MIT |
| `signal-exit` | 3.0.7 | ISC |

DSH/React peer dependencies由宿主提供；本次解析到的 rc.8 DSH peers 与 React 18.3.1 均为 MIT。`pnpm licenses list --prod --json` 还会包含 monorepo 开发/peer 图中的 `argparse`（Python-2.0），但它不在上述 tarball clean-install runtime tree 中。

当前没有 native binary、第三方图片、字体、模型权重或复制的竞品代码。运行时依赖均为 permissive license；MIT/ISC 文本随各 npm dependency 分发，公开 bundle 自身包含 MIT `LICENSE`。发布前仍应保留自动化许可证清单，并在依赖变化时重新复核。

## 已知限制

- local Host authority 仅支持 loopback 单 Owner 部署；其他 channel 失败关闭；
- 自动候选抽取 Provider 默认未捆绑；用户仍可用受治理工具提出候选；
- 默认检索为本地 BM25；PageIndex/graph adapters 默认关闭；
- lifecycle plan 是进程内确认对象，重启后要重新 plan；
- legacy import batch 尚无整批正常业务撤销命令，但离线 standalone migration 具备 exact-generation rollback，单条导入记忆可走 append-only forget；
- DSH 处于 pre-release；每个新 rc 都要重新跑完整矩阵后才能扩大声明。

## Owner 手动发布步骤

Agent 不执行以下命令。Owner 在确认版本、PR、tag 与 tarball digest 后，可自行运行：

```powershell
npm publish .artifacts/npm/mistymoon-dsh-mmem-0.0.1-alpha.0.tgz --access public
```

发布后再决定 dist-tag，并用全新 DSH Home 从 registry 包重复一次 clean Profile smoke。不要把 npm token 写入仓库、脚本、Issue 或 CI 日志。
