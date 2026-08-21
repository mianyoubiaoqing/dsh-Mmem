# `@mistymoon/dsh-mmem` 0.0.1-alpha.1 发行验收

日期：2026-08-21

兼容基线：DeepSeek Harness `0.1.0-rc.8`

公开 peer range：`>=0.1.0-rc.7 <0.1.0`

## 发行内容

- 修复全新 DSH Workspace 尚未绑定默认 Memory Space 时显示通用读取错误的问题，改为自动进入首次设置。
- 新增侧栏 Memory 入口以及目录/语义图谱浏览器，使用 rc.8 的 `sidebar.footer.action` 与 `shell.overlay` 公开插槽。
- 新增 Owner 审批的 `related-to`、`elaborates`、`contradicts` 关系，并与 Candidate approval 在同一 Archive 事务内提交。
- 新增无需外接 embedding Provider 的本地确定性关系建议开关；关系当前只用于治理与展示，不参与召回。
- 改进简体中文文案、表单标签、错误重试、首次设置和响应式 Settings UI。

## 已执行验收

在 Windows 10/PowerShell 仓库环境执行：

```powershell
pnpm exec vitest run packages/memory/tests/memory-conflict-supersession.spec.ts packages/memory/tests/memory-settings-host.spec.ts packages/memory/tests/memory-settings-client.spec.ts packages/settings-ui/tests/memory-settings-tab.spec.tsx packages/settings-ui/tests/memory-explorer.spec.tsx packages/settings-ui/tests/memory-client-registration.spec.ts
pnpm check
git diff --check
```

结果：

- 定向测试：6 个文件、36 项测试通过。
- 完整测试：33 个文件、199 项测试通过。
- TypeScript typecheck、Memory/Settings UI build、built plugin smoke 与 packed publication smoke 通过。
- `git diff --check` 通过。

最终版本提升后已再次执行：

```powershell
pnpm check
pnpm pack:npm
```

产物：`.artifacts/npm/mistymoon-dsh-mmem-0.0.1-alpha.1.tgz`

大小：`191437` bytes

SHA-256：`4A42439E6434C16CFACF563EDF1D5CE0D8DA570A3514081EBE3240330D7D5832`

## 隐私、许可证与产物边界

- 测试只使用中性生成数据和系统临时目录。
- tarball 只允许包含 `LICENSE`、`README.md`、`cordis.patch.yml`、`package.json` 与 `lib/memory/`、`lib/settings-ui/`。
- 不包含真实 Memory、Persona、DSH Home、Session、日志、凭据、迁移数据库或诊断转储。
- 根 workspace 与内部包保持 `private: true`；唯一公开安装面仍为 `@mistymoon/dsh-mmem`。
- 本仓库使用 MIT License；本次变更没有引入新的第三方源码或视觉资产。

## 升级与回退限制

`relationship-confirmed` 扩展了 storage-v2 Archive 的事件词汇。新版本可以读取旧 Archive；一旦写入首个关系事件，旧插件版本会拒绝未知事件，因此不支持直接降级读取该 Archive。升级前应保留可恢复备份。

## 发布边界

Agent 只生成并审计 `.tgz`，不登录 npm、不读取 token、不执行 `npm publish`、不更改 dist-tag，也不创建 GitHub Release。合并 PR 后由 Owner 手动执行文末记录的确切发布命令。

```powershell
npm publish .\.artifacts\npm\mistymoon-dsh-mmem-0.0.1-alpha.1.tgz --tag alpha --access public
```
