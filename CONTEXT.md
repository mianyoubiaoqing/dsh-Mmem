# Governed Memory

dsh-Mmem 管理可追溯、可审核并按明确访问关系召回的长期记忆。它区分事实所属的语义范围、记忆所在的空间，以及 DSH Workspace 被授予的读取和写入关系。

## Ownership and meaning

**Owner**:
拥有、配置并治理一组记忆空间的人；模型、DSH Workspace 或 Provider 都不能自行取得 Owner 权限。
_Avoid_: User、当前说话者、Agent

**Memory Scope**:
一条记忆在事实语义上成立的世界或叙事范围；它与存储位置和 DSH Workspace 访问权正交。
_Avoid_: Memory Space、DSH Workspace、分区

**Memory Kind**:
一条记忆的稳定治理类别，用于决定审批、共享、有效期和召回规则；它不是模型生成的 topic 或检索标签。
_Avoid_: tag、embedding class、Memory Scope

**Source Space**:
一条 Observation、Candidate 或 Confirmed Memory 唯一归属的 Memory Space；跨空间召回不会改变该归属。
_Avoid_: 当前 DSH Workspace、召回目标、复制空间

## Memory relationships

**Relationship Candidate**:
连接两条 Confirmed Memory 的待审核语义关系建议；它不是治理事实，也不得影响召回。
_Avoid_: Confirmed Memory Relationship、相似度命中、图谱边

**Confirmed Memory Relationship**:
Owner 明确批准的两条 Confirmed Memory 之间的受治理语义关系；它拥有来源与修订历史，并且只有两个端点都可披露时才可见。
_Avoid_: Relationship Candidate、检索相似度、Memory Space sharing relation

**Summary Memory**:
由多条来源记忆归纳出的新 Confirmed Memory，并保留完整来源记忆关系；它不是连接既有记忆的语义关系。
_Avoid_: Confirmed Memory Relationship、合并显示、图谱分组

## Provisional memory

**Pending Candidate**:
尚未得到 Owner 确认、可能不准确，并在到期前仅能于其 Source Space 内临时召回的记忆候选；它不是治理事实。
_Avoid_: Confirmed Memory、不可靠的 Confirmed Memory、Import Draft

**Provisional Recall**:
当前 Session 进入 Candidate 的 Source Space 后，对未过期 Pending Candidate 进行的受限召回；它不会通过 Space sharing 关系传播。
_Avoid_: Borrowed Recall、Confirmed Memory Recall、Workspace-local Recall

**Source Turn**:
产生 Candidate 的一个顶层 DSH 用户可见交互轮次；DSH Session 是其原始内容的权威来源。
_Avoid_: Memory Space、完整 Session、隐藏推理

**Turn Summary Policy**:
Owner 对一个 Memory Space 内 Source Turn 摘要方式的版本化选择；默认本地确定性压缩，只有显式 opt-in 才调用 DSH 模型。
_Avoid_: Workspace 模型设置、审批策略、Confirmed Memory

**Turn Evidence Capsule**:
与 Pending Candidate 同寿命、属于其 Source Space 的 Source Turn 临时证据副本；它只包含用户可见内容，过期或完成治理后清除 payload。
_Avoid_: DSH Session、Confirmed Memory、永久 Conversation Archive

**Expired Candidate**:
超过审核期限且不再允许召回或治理的 Candidate；它只保留无 payload 的审计事实。
_Avoid_: Rejected Candidate、Forgotten Memory、Archived Memory

## Spaces and DSH workspaces

**Memory Space**:
Owner 创建的独立治理与召回单元，一条记忆恰好属于一个 Memory Space。
_Avoid_: Memory Scope、数据库分区、文件夹

**DSH Workspace**:
由 DSH 创建、识别并为 Session 提供工作上下文的 Workspace；dsh-Mmem 只消费这一身份，不创建自己的 Workspace 模型。
_Avoid_: Workspace Reference、任意路径、项目名、Memory Space

**Workspace Binding**:
一个 DSH Workspace 与一个 Memory Space 之间由 Owner 建立的读取或读写授权关系；它允许 Session 进入 Space，但不把 Space 内容重新分区到来源 Workspace。
_Avoid_: 自动发现、路径匹配、Space Share Grant

**Default Write Space**:
一个 DSH Workspace 的新 Observation 与 Candidate 默认进入的唯一 Memory Space。
_Avoid_: 当前查询空间、全局空间、最近使用空间

**Active Space**:
一个 DSH Session 当前用于写入和开始召回的 Memory Space，必须来自该 Session 所属 DSH Workspace 的有效 Binding。
_Avoid_: 所有已绑定空间、最近命中空间、Source Space

## Inter-space sharing

**Inter-Space Mode**:
Owner 对跨 Memory Space 召回的总开关，取 Isolated、Selective 或 Federated；它不改变 Workspace Binding 或记忆归属。
_Avoid_: 网络权限、同步模式、Memory Scope

**Isolated**:
只召回当前 Session 的 Active Space，不执行跨空间扩展。
_Avoid_: 离线模式、私密可见性

**Selective**:
只按显式 Space Share Grant 扩展召回，并应用该 Grant 的稳定过滤条件。
_Avoid_: 自动相关空间、模型选择共享

**Federated**:
在 Owner 明确选择的 Space Federation 内执行完整跨空间召回；新建空间不会自动加入。
_Avoid_: 全局所有空间、无限制访问

**Space Share Grant**:
Source Space 授予一个目标 Memory Space 的单向只读召回关系；Grant 不传递，也不允许目标修改来源记录。
_Avoid_: Workspace Binding、复制、同步

**Space Federation**:
Owner 明确列出的一组可完全互相召回的 Memory Space；成员关系是显式且版本化的。
_Avoid_: 所有空间、默认全局组、DSH Workspace group

**Borrowed Recall**:
依据 Space Share Grant 或 Space Federation 从非直接空间选出的只读召回项，其 receipt 保留 Source Space 与授权关系。
_Avoid_: 导入、复制记忆、本地记忆
