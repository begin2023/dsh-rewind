# 参与贡献 / Contributing

欢迎提交问题与修改。主 README 使用中文，英文版本在 [README.en.md](README.en.md)；修改功能和行为时请同步更新两份文档。

Bug reports and pull requests are welcome. Keep the Chinese and English README files in sync when changing behavior.

## 开发 / Development

需要 Node.js 20 或更新版本。

```sh
npm ci
npm run check
npm test
npm pack --dry-run
```

插件没有构建步骤。宿主实现位于 `index.js`，浏览器模块位于 `client.js`，离线测试位于 `test/`。React 由 DSH 提供，本地 React 和 jsdom 仅用于测试。

There is no build step. `index.js` implements the host plugin, `client.js` implements the browser module, and `test/` contains offline tests. DSH supplies React in production; local React and jsdom dependencies are for testing only.

## 提交修改 / Submitting changes

- 描述具体问题、预期行为和实际行为，注明 DSH 版本、操作系统及复现步骤。不要上传真实会话内容、附件、供应商配置或密钥。
- 消息截断、异步操作、附件和会话切换的修复应有能复现问题的回归测试。
- 保留追加式历史事件与 Session Surface 设计；不要直接覆盖会话日志。
- 本地抓包、打包文件和其他验证产物放在已忽略的 `artifacts/` 中。

Describe the issue, expected and actual behavior, DSH version, operating system, and reproduction steps. Do not upload private conversations, attachments, provider configuration, or credentials. Add a regression test for changes to truncation, asynchronous behavior, attachment handling, or session switching. Preserve append-only history and Session Surface semantics. Keep local recordings and generated artifacts under the ignored `artifacts/` directory.

贡献代码以本项目的 [MIT License](LICENSE) 发布。

Contributions are licensed under the project's [MIT License](LICENSE).
