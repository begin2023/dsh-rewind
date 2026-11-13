# 更新记录 / Changelog

## 0.1.0 — 2026-11-14

首次社区发布，npm 包名为 `@begin2023/dsh-rewind`，采用 MIT 协议。

- 支持用户消息编辑及助手回复重新生成，使用 DSH 原生 Session Surface 替换当前上下文。
- 保留图片和文件引用，支持编辑附件及恢复历史用户输入。
- 精简为「编辑」与「重新生成」两种消息操作，兼容旧版本历史标记。
- 修复修改前错误导致的提前截断、取消失败及空闲超时、同会话并发、目标类型校验和附件大小计数问题。
- 修复保存中附件变更、关闭后继续提交、重复恢复、输入法组合误提交及弹窗无障碍名称问题。
- 提供中文主 README、英文 README、插件元数据及可移植离线测试与 CI。

First public release under the MIT license, published as `@begin2023/dsh-rewind`. Includes message editing, reply regeneration, attachment preservation and historical input restoration. Adds validation before context replacement, cancellation and concurrency guards, stable editor snapshots, restoration guards, IME handling, accessible dialogs, bilingual documentation, and portable tests with CI.
