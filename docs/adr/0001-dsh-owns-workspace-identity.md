---
status: accepted
---

# DSH owns Workspace identity

DSH 是 Workspace 身份与生命周期的唯一权威，dsh-Mmem 只把 Memory Space 绑定到 DSH 提供的 Workspace，不创建 `Workspace Reference`、插件 Workspace ID、realpath/hash 或项目名映射。DSH 0.1.0-rc.7 尚无公开稳定 Workspace ID，因此当前 Adapter 使用 SessionHeader 中持久化的 exact validated absolute `cwd`；缺失时失败关闭，未来改用 DSH 稳定 ID 必须走显式版本迁移。
