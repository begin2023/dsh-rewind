
import fs from 'node:fs'
import { createRequire } from 'node:module'

const require = createRequire('/tmp/rendertest/')
const React = require('react')
const { renderToStaticMarkup } = require('react-dom/server')

const source = fs.readFileSync('/Users/youngwu/Documents/code/dsh-rewind/client.js', 'utf8')

const styleNodes = []
const document = {
  head: { appendChild(node) { styleNodes.push(node) } },
  body: { appendChild() {} },
  createElement(tag) {
    return { tagName: tag, id: '', textContent: '', parentNode: null,
      remove() {}, setAttribute() {}, appendChild() {}, addEventListener() {}, removeEventListener() {} }
  },
  getElementById() { return null },
  addEventListener() {}, removeEventListener() {},
}

let factory = null
const window = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (id) => clearTimeout(id),
  __ModuleLoader__: {
    load(spec) {
      factory = spec.factory((name) => {
        if (name === 'react') return React
        throw new Error('unexpected require: ' + name)
      })
    },
  },
}

const run = new Function('window', 'document', 'fetch', 'File', 'btoa', 'atob', 'console', source)
run(window, document, () => Promise.reject(new Error('fetch must not run during render')),
  class File {}, (s) => Buffer.from(s, 'binary').toString('base64'),
  (s) => Buffer.from(s, 'base64').toString('binary'), console)

const results = []
const check = (name, ok, detail) => results.push({ name, ok: Boolean(ok), detail: String(detail === undefined ? '' : detail) })

const slots = []
const ctx = {
  effect(fn) { const d = fn(); return typeof d === 'function' ? d : () => {} },
  get(name) { return name === 'uiConversation' ? { events: { register() { return () => {} } } } : undefined },
  inject(names, cb) { cb({ get: () => undefined }) },
  slots: {
    inject(seat, cb) { const d = cb(); return typeof d === 'function' ? d : () => {} },
    register(options, component) { slots.push({ options, component }); return () => {} },
  },
  logger() { return { warn() {}, info() {} } },
}
factory.apply(ctx)

const byKey = {}
for (const entry of slots) byKey[(entry.options.key || entry.options.id)] = entry.component

const T = factory.__test
const snapshot = {
  nodes: new Map([
    ['13:input-messageu1', { key: '13:input-messageu1', kind: 'user', anchorSeq: 2, data: { seq: 2, messageId: 'u1', content: [{ type: 'text', text: 'hi' }] } }],
    ['16:assistant-stepm1', { key: '16:assistant-stepm1', kind: 'assistant-step', anchorSeq: 4, data: { finalNode: { messageId: 'm1', seq: 4 } } }],
    ['15:rewind-marker9', { key: '15:rewind-marker9', kind: 'rewind-marker', anchorSeq: 9, data: { kind: 'recall', startSeq: 2, endSeq: 9, shadowed: [2, 4] } }],
  ]),
  order: [],
}
const useChat = (selector) => selector(snapshot)
const inputActions = { setDraft() {}, addAttachments() { return true }, submit() {} }

const render = (label, element) => {
  try {
    const html = renderToStaticMarkup(element)
    check(label + ' renders', html.length > 0, html.slice(0, 90))
    return html
  } catch (error) {
    check(label + ' renders', false, error && error.stack ? error.stack.split('\n').slice(0, 3).join(' | ') : error)
    return ''
  }
}

const userBlocks = [
  { type: 'text', text: '看看这张图和笔记' },
  { type: 'image', attachment: { attachmentId: 'a1', mediaType: 'image/png', name: 'map.png' } },
  { type: 'file', attachment: { attachmentId: 'a2', mediaType: 'text/markdown', name: 'notes.md' } },
]

const userHtml = render('UserActionsRow', React.createElement(T.UserActionsRow, {
  node: { key: '15:rewind-actionsu1', kind: 'rewind-actions', anchorSeq: 2, data: { seq: 2, messageId: 'u1', content: userBlocks } },
  sessionId: 's1', inputActions, t: (k) => k,
}))
check('user row has 编辑', userHtml.includes('编辑'), userHtml.includes('编辑'))
check('user row has 重发', userHtml.includes('重发'), userHtml.includes('重发'))
check('user row has 撤回', userHtml.includes('撤回'), userHtml.includes('撤回'))

const assistantHtml = render('AssistantActions', React.createElement(T.AssistantActions, {
  messageId: 'm1', sessionId: 's1', useChat, t: (k) => k,
}))
check('assistant row has 2 icon buttons', (assistantHtml.match(/<button/g) || []).length === 2, (assistantHtml.match(/<button/g) || []).length)

const markerHtml = render('MarkerRow', React.createElement(T.MarkerRow, {
  node: { key: '15:rewind-marker9', kind: 'rewind-marker', anchorSeq: 9, data: { kind: 'recall', startSeq: 2, endSeq: 9, shadowed: [2, 4] } },
  sessionId: 's1', useChat, inputActions, t: (k) => k,
}))
check('marker shows 已撤回', markerHtml.includes('已撤回'), markerHtml.slice(0, 120))
check('marker offers 放回输入框', markerHtml.includes('放回输入框'), markerHtml.includes('放回输入框'))

const editHtml = render('EditDialog', React.createElement(T.EditDialog, {
  sessionId: 's1', seq: 2, initialText: '看看这张图和笔记',
  initialItems: [
    { key: 'existing-0-a1', block: userBlocks[1], name: 'map.png', mediaType: 'image/png', isImage: true },
    { key: 'existing-1-a2', block: userBlocks[2], name: 'notes.md', mediaType: 'text/markdown', isImage: false },
  ],
  onClose: () => {},
}))
check('edit dialog keeps both attachments', editHtml.includes('map.png') && editHtml.includes('notes.md'), editHtml.includes('map.png') + '/' + editHtml.includes('notes.md'))
check('edit dialog has save button', editHtml.includes('保存并重新发送'), editHtml.includes('保存并重新发送'))
check('edit dialog has add button', editHtml.includes('添加图片或文件'), editHtml.includes('添加图片或文件'))

const recallHtml = render('ConfirmRecall', React.createElement(T.ConfirmRecall, { sessionId: 's1', seq: 2, role: 'user', onClose: () => {} }))
check('recall dialog explains context cut', recallHtml.includes('模型上下文中移除'), recallHtml.slice(0, 140))

const hideHtml = renderToStaticMarkup(React.createElement(T.HideSync, { useChat }))
check('HideSync renders nothing', hideHtml === '', hideHtml)

const failed = results.filter((r) => !r.ok)
for (const r of results) console.log((r.ok ? 'ok   ' : 'FAIL ') + r.name + (r.ok ? '' : '  -> ' + r.detail))
console.log(failed.length === 0 ? 'RENDER OK (' + results.length + ' checks)' : 'RENDER FAILED (' + failed.length + '/' + results.length + ')')
process.exitCode = failed.length === 0 ? 0 : 1
