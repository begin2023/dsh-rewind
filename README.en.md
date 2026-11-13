# DSH Rewind

[中文](README.md) · [npm](https://www.npmjs.com/package/@begin2023/dsh-rewind) · [GitHub](https://github.com/begin2023/dsh-rewind)

A conversation editing and response regeneration plugin for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness). Edit a sent message, keep its attachments, and continue from the revised input.

## Features

- **Edit user messages:** change the text, keep or remove existing attachments, and add images or files. Submit without changing the text to send the same input again.
- **Regenerate assistant replies:** reuse the corresponding user message, including its attachments.
- **Continue from the revision:** earlier messages remain in the model context. The original input, its answer, and later messages leave the active context and are replaced by the revised conversation. Regeneration also replaces that turn and all later turns.
- **Keep history:** write replacement markers through DSH's native Session Surface instead of modifying historical events or rewriting session files. An edit marker can put the original user input and its attachments back into the composer.
- **Use the host UI:** register conversation slots and use the host theme. No separate server or frontend build is required.

The message actions are **Edit** for user messages and **Regenerate** for assistant replies. The plugin UI currently uses Chinese; documentation is available in both Chinese and English.

## Installation

Install this npm package from **Settings → Plugins** in DSH:

```text
@begin2023/dsh-rewind
```

Or use the DSH CLI. The desktop application's default profile is usually `desktop`; substitute the profile you actually use:

```sh
dsh plugin --profile desktop add @begin2023/dsh-rewind
```

Restart the corresponding DSH instance after installation or upgrades. For a standalone Web profile:

```sh
dsh plugin --profile web add @begin2023/dsh-rewind
```

The unscoped npm name `dsh-rewind` belongs to another project. Use the full `@begin2023/dsh-rewind` name.

## Usage

**Edit a sent question:** click “编辑” below the user message, update the text and attachments, and submit. DSH generates a new reply from that point; the old messages from that point onward leave the active model context.

**Regenerate an answer:** click “重新生成” below an assistant reply. The corresponding user input and its original image and file blocks are reused. Submitting an unchanged edit also resends the input.

**Restore a historical input:** choose “放回输入框” on an edit replacement marker. Attachment types are preserved. Check the destination session and composer contents before sending.

Images remain image blocks and files remain attachment blocks; filenames are not used as substitutes for their contents. Restoring an attachment requires its original data to remain available in the local attachment store.

## Behavior and limitations

- Historical events remain on this machine. DSH's message projection determines the active context. Disabling the plugin does not delete events.
- Truncating conversation context does not undo file changes, commands, or external service actions that already ran.
- Active generation must stop safely before a revision. Queued inputs or failure to establish an idle session cause the operation to be refused.
- Only identifiable user inputs and assistant replies can be revised. Stale or mismatched message positions are rejected.
- The plugin uses the host's authenticated session and attachment interfaces. It does not configure, read, or proxy provider credentials; DSH sends model requests.
- The plugin depends on DSH's Session Surface, attachment service, and client slot APIs. It has been validated against desktop runtime **0.2.2-rc.2**. Verify compatibility when upgrading the host.

## Development and validation

Node.js 20 or newer is required. DSH supplies React at runtime; development dependencies are used only for tests.

```sh
npm ci
npm run check
npm test
npm pack --dry-run
npm run test:consumer
```

Tests cover loading, host routes, message projection, attachments, rendering, and interaction. Release validation also uses the installed DSH Session → AgentLoop → PiAi pipeline with a local HTTP recording endpoint. Six requests and twelve assertions verify editing, continuation, and regeneration, including that replaced content never reappears in the model context. This uses an isolated test session, does not access the current desktop conversation, and does not validate every provider protocol.

See the [implementation notes](docs/DETAIL.md) and [contribution guide](CONTRIBUTING.md). The [Chinese requirements](docs/REQUIREMENTS.md) cover the host contracts in more detail. Report bugs through [Issues](https://github.com/begin2023/dsh-rewind/issues).

## License

[MIT](LICENSE), matching [dsh-weight-journal](https://github.com/begin2023/dsh-weight-journal).

[![powered by dsh](https://img.shields.io/badge/powered_by-dsh-4D6BFE?style=flat-square&logo=deepseek&logoColor=white)](https://github.com/deepseek-ai/deepseek-harness)
