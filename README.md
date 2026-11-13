# dsh-rewind

DSH 插件：在会话里对**任意一条消息**做 **编辑 / 撤回 / 重发 / 重新生成**，并且**图片和其它附件一律不丢**。

它不是另开一个聊天窗口，而是直接作用在你当前这条 DSH 会话上：改完之后，模型上下文里真的只剩改写后的内容，界面上的历史会折叠成一行提示，随时可以把文字和附件放回输入框。

## 它解决什么

DSH 本身没有「改掉上一条消息」的能力。你只能继续往下说，模型永远记得你说错的那句话。
dsh-rewind 补上这个缺口：

- **编辑**：把某条用户消息改成新内容，从这条开始往后的旧内容从模型上下文里移除，然后按新内容重新提问。**原来带的图片和文件会一起带上**，你也可以在编辑面板里增删附件。
- **撤回**：把某条消息（以及它之后的所有内容）从模型上下文中移除。界面折叠成一行「已撤回」提示，模型之后不会再记得它们。
- **重发**：把这条消息的文字和**全部附件**放回输入框，并给一个「立即发送」按钮，改一改再发。
- **重新生成**：对某条助手回复，用它对应的原始提问（含图片、文件）重新跑一次。

## 为什么不会丢图

大多数「重发」实现只把文字塞回输入框，图片就没了。这里所有操作都基于会话里**原始的 content blocks**：

- 编辑时：非文本块（image / file）按 attachmentId 白名单原样保留，新加的附件先经宿主附件服务入库再追加。
- 重新生成时：直接取原 user/message 的 content 数组重发，图片与文件引用原封不动。
- 重发时：逐个附件从附件存储读回字节，重新建成草稿放进输入框，和手动粘贴附件走同一条通道。

附件永远不会被重新编码或压缩。

## 工作原理

三层，全部只用官方机制，不写自定义会话事件类型：

1. **模型层**：往会话尾部 append 一条内容为空的 `system/message`，带
   `surfaceOp: { op: 'replace', startSeq, endSeq }` 和 `sourceEventSeqs`。
   空内容让 `deriveEventMessage` 返回 null，于是这条替换不产生任何 provider 消息——
   被遮蔽的区间在模型眼里就是彻底不存在。
2. **持久层**：marker 的 `data.message.id` 是 `rewind:<kind>:<uuid>`，`sourceEventSeqs` 列出被遮蔽的每个 surface 节点。
   折叠状态完全可以从会话日志重建，不依赖外部数据库，fork / 恢复都保持诚实。
3. **界面层**：客户端插件注册两个自定义 chat node（消息下方的操作行、撤回提示行），
   用官方 keyed slot `conversation.chat.node` 渲染；被遮蔽的行按 `data-chat-node-key` 生成 CSS 隐藏规则。
   替换事件本身不会产生可见行，所以不会出现重复气泡。

## 安装

已经装进 `~/.dsh/profiles/desktop`：

- `package.json` 的 `dependencies` 里是 `\"dsh-rewind\": \"link:/Users/youngwu/Documents/code/dsh-rewind\"`
- `dsh.profile.bundles` 里加了 `dsh-rewind`
- `node_modules/dsh-rewind` 是指向本目录的软链

手动安装等价做法：

```bash
cd ~/.dsh/profiles/desktop
npm pkg set 'dependencies.dsh-rewind=link:/Users/youngwu/Documents/code/dsh-rewind'
ln -sfn /Users/youngwu/Documents/code/dsh-rewind node_modules/dsh-rewind
# 再把 \"dsh-rewind\" 加进 package.json 的 dsh.profile.bundles
```

装完或改完代码后需要**重启 DSH**（插件在启动时加载，热改 client.js 不会生效）。

## 用法

- 鼠标移到（或键盘聚焦到）任意一条消息，下方会浮出一行操作：用户消息是 **编辑 / 重发 / 撤回**，助手回复是 **重新生成 / 撤回**。
- **编辑**：弹出面板，正文可改，原有附件以卡片列出，可以 ✕ 移除，也可以「添加图片或文件」。`Cmd/Ctrl + Enter` 保存，`Esc` 关闭。
- **撤回**：先确认再执行，提示里写明「这条消息以及它之后的内容会从模型上下文中移除」。
- 撤回 / 编辑之后，界面上会留下一行折叠提示，点「放回输入框」就能把文字和附件拿回来。
- 失败都会以 toast 说明原因（例如「该会话尚未加载，请先在 DSH 里打开它」）。

## 和 dsh-claude-style 的关系

DSH 里如果同时装了 `dsh-claude-style`，用户消息下方会看到**两套**编辑/撤回按钮，语义不一样：

| | dsh-claude-style | dsh-rewind |
| --- | --- | --- |
| 编辑 | 从这条消息**分岔出一个新会话**，把改过的文字发过去 | **原地改写当前会话**，旧的后续内容从模型上下文移除 |
| 撤回 | 分岔新会话，把原文放回新会话的输入框 | 原地把这段从模型上下文移除，界面折叠成提示行 |

两条路都成立，但混在一起会让人不知道点哪个。建议只留一套：
DSH 设置 → 会话 → 关掉 claude-style 的「消息操作」；或者在插件市场停用其中一个。

## 主题与皮肤

- 所有颜色都走 `--dsw-alias-*` 设计令牌（label-primary / label-secondary / label-tertiary、border-l2、
  bg-layer-2 / bg-layer-3、interactive-bg-hover、brand-primary、state-error-primary 等），
  浅色、深色、原生皮肤都自动跟随，不需要额外适配。
- 弹窗是命令式 DOM，直接挂到 `document.body`，不挂在消息行里。
  原因是官方聊天滚动容器带 `container-type: inline-size`（layout containment），
  会成为 `position: fixed` 后代的包含块，弹窗会被裁在滚动区里、跟着内容滚走——
  早期版本「点编辑之后什么都看不见」就是这个问题。

## 测试

```bash
cd /Users/youngwu/Documents/code/dsh-rewind
npm test
```

四套离线测试，共 123 项，不需要启动 DSH：

| 文件 | 覆盖 |
| --- | --- |
| `test/smoke.mjs` | 客户端 bundle 能否加载、definition / slot 注册、node key 换算、隐藏规则生成 |
| `test/host.mjs` | 宿主侧真实调用六条路由：编辑保留/删除附件、撤回遮蔽、重新生成沿用原附件、上传与读取、各类错误分支 |
| `test/render.mjs` | 用 React SSR 渲染每个组件，检查按钮与文案 |
| `test/interact.mjs` | jsdom + React DOM 真实点击：编辑面板改字/删附件/加文件/保存、撤回确认、Esc 关闭、重发回填与「立即发送」、提示行的隐藏样式 |

## 已知边界

- 撤回只让模型「看不见」，原始事件仍留在会话日志里（这是不破坏日志可读性的代价）；界面通过折叠提示表达这件事。
- 只有用户消息可以编辑；助手回复只能重新生成或撤回。
- 「重新生成」需要这条回复前面能找到对应的用户提问。
- 编辑时新添加的附件会作为新附件入库一次，不会复用旧附件记录。
- 宿主接口依赖会话处于加载状态：请先在 DSH 里打开那个会话再操作。
