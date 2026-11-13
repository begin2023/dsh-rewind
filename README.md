# DSH Rewind

[English](README.en.md) · [npm](https://www.npmjs.com/package/@begin2023/dsh-rewind) · [GitHub](https://github.com/begin2023/dsh-rewind)

[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的会话编辑与重新生成插件。在消息下方直接修改问题、保留附件，并从修改处继续对话。

## 功能

- **编辑用户消息**：修改正文，选择保留或移除已有附件，也可以追加图片和文件；不改正文直接提交，就能重新发送这条消息。
- **重新生成助手回复**：沿用该轮用户消息及其附件，重新生成回复。
- **从修改处继续**：编辑后，模型上下文保留前面的消息，使用修改后的问题；旧问题、旧回答以及后续对话退出当前上下文。重新生成同样会替换该轮及后续对话。
- **保留历史**：通过 DSH 原生 Session Surface 写入替换标记，不修改历史事件，也不直接覆盖会话文件。编辑替换标记可以将原始用户输入及附件放回输入框。
- **跟随宿主主题**：使用 DSH 的界面插槽与主题变量，无需单独启动网页或构建前端。

消息操作入口只有用户消息下的「编辑」和助手回复下的「重新生成」。插件界面当前以中文显示；本说明同时提供英文版本。

## 安装

在 DSH 的 **设置 → 插件** 中安装 npm 包：

```text
@begin2023/dsh-rewind
```

也可以使用 DSH CLI。桌面版的默认 profile 通常为 `desktop`，请按实际使用的 profile 调整：

```sh
dsh plugin --profile desktop add @begin2023/dsh-rewind
```

安装或升级后重启对应的 DSH 实例。独立 Web profile 的示例：

```sh
dsh plugin --profile web add @begin2023/dsh-rewind
```

npm 上的同名 `dsh-rewind` 属于其他项目；请使用完整的 `@begin2023/dsh-rewind` 包名。

## 使用

**修改已发送的问题**：点击用户消息下的「编辑」，调整正文和附件，然后提交。插件会从该消息重新生成回复；该位置之后的旧对话退出当前模型上下文。

**重新生成回复**：点击助手消息下的「重新生成」，复用对应的用户输入，包括图片和文件。没有改动正文的编辑提交也可以达到重新发送的效果。

**恢复历史输入**：点击编辑替换标记上的「放回输入框」继续编辑原始输入。恢复动作会保留附件内容类型；立即发送前请确认目标会话和输入内容。

图片作为图片块重新提交，文件作为附件块重新提交，不会把附件替换成文件名占位符。恢复需要本机附件存储中的原始文件仍然可用。

## 行为与限制

- 历史事件保留在本机；当前上下文由 DSH 的消息投影决定。停用插件不会删除已有事件。
- 截断会话上下文不会撤销已经执行的文件修改、命令或外部服务操作。
- 正在生成时先安全停止生成；存在排队输入或无法确认空闲时会拒绝修改。
- 仅操作可定位的用户输入和助手回复；过时或不匹配的消息位置会被拒绝。
- 插件本身通过宿主的已认证接口访问会话和附件，不配置、读取或代理模型供应商密钥。模型请求仍由 DSH 负责。
- 插件依赖 DSH 的 Session Surface、附件服务和客户端插槽 API。当前在 DSH 桌面运行时 **0.2.2-rc.2** 上验证；升级宿主后建议重新验证相关功能。

## 本地开发与验证

需要 Node.js 20 或更新版本。React 由 DSH 宿主提供；本地开发依赖只用于测试。

```sh
npm ci
npm run check
npm test
npm pack --dry-run
npm run test:consumer
```

测试涵盖插件加载、宿主路由、消息投影、附件、组件渲染和交互。发布前另外使用安装版 DSH 的真实 Session → AgentLoop → PiAi 适配器，将请求发到本地 HTTP 接收端，通过 6 次请求、12 项断言核对编辑、续聊及重新生成后的请求正文，确认被替换的内容不会重新进入模型上下文。这项验证使用隔离测试会话，不涉及当前桌面会话，也不覆盖所有供应商协议。

更多实现说明见 [功能与实现边界](docs/REQUIREMENTS.md)。欢迎通过 [Issues](https://github.com/begin2023/dsh-rewind/issues) 报告问题，提交修改前请阅读 [贡献指南](CONTRIBUTING.md)。

## 开源协议

与 [dsh-weight-journal](https://github.com/begin2023/dsh-weight-journal) 相同，采用 [MIT License](LICENSE)。

[![powered by dsh](https://img.shields.io/badge/powered_by-dsh-4D6BFE?style=flat-square&logo=deepseek&logoColor=white)](https://github.com/deepseek-ai/deepseek-harness)
