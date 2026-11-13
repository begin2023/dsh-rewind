import fs from 'node:fs'
import { createRequire } from 'node:module'

const require = createRequire('/tmp/rendertest/')
const { JSDOM } = require('jsdom')

const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>', {
  url: 'http://127.0.0.1/',
  pretendToBeVisual: true,
})
const win = dom.window

globalThis.window = win
globalThis.document = win.document
globalThis.HTMLElement = win.HTMLElement
globalThis.Node = win.Node
globalThis.Event = win.Event
globalThis.MouseEvent = win.MouseEvent
globalThis.KeyboardEvent = win.KeyboardEvent
globalThis.IS_REACT_ACT_ENVIRONMENT = true

const React = require('react')
const { createRoot } = require('react-dom/client')
const act = React.act || require('react-dom/test-utils').act

/* ---------------------------------------------------------------- host --- */

const calls = []
const hostValue = (op) => {
  if (op === 'attachment') return { name: 'map.png', mediaType: 'image/png', data: 'aGVsbG8=' }
  if (op === 'upload') {
    return { block: { type: 'image', attachment: { attachmentId: 'new-a', mediaType: 'image/png', name: 'extra.png' } } }
  }
  if (op === 'recall') return { shadowed: 3 }
  if (op === 'edit') return { shadowed: 3, truncated: 2 }
  if (op === 'regenerate') return { shadowed: 2 }
  return {}
}

const fetchStub = async (url, init) => {
  const target = String(url)
  const op = target.slice(target.lastIndexOf('/') + 1)
  const body = init && typeof init.body === 'string' ? JSON.parse(init.body) : {}
  calls.push({ op: op, body: body })
  const payload = { ok: true, value: hostValue(op) }
  return {
    ok: true,
    status: 200,
    headers: { get: () => 'application/json' },
    text: async () => JSON.stringify(payload),
    json: async () => payload,
  }
}

const conversationCalls = { drafts: [], released: [] }
const conversationService = {
  fileUploads: { getSnapshot: () => ({}) },
  createDrafts(sessionId, files) {
    conversationCalls.drafts.push({ sessionId: sessionId, names: files.map((file) => file.name) })
    return files.map((file, index) => ({ kind: 'file', id: 'draft-' + index, file: file }))
  },
  resolveDraftAttachments(ids) {
    return ids.map((id) => ({ id: id }))
  },
  releaseDraftAttachments(list) {
    conversationCalls.released.push(list)
  },
}

const inputActions = {
  drafts: [],
  attachments: [],
  submits: 0,
  setDraft(text) {
    this.drafts.push(text)
  },
  addAttachments(ids) {
    this.attachments.push(ids)
    return true
  },
  submit() {
    this.submits += 1
  },
}

let factory = null
win.__ModuleLoader__ = {
  load(spec) {
    factory = spec.factory((name) => {
      if (name === 'react') return React
      throw new Error('unexpected require: ' + name)
    })
  },
}

const source = fs.readFileSync('/Users/youngwu/Documents/code/dsh-rewind/client.js', 'utf8')
const run = new Function('window', 'document', 'fetch', 'File', 'btoa', 'atob', 'console', source)
run(
  win,
  win.document,
  fetchStub,
  win.File,
  (text) => Buffer.from(text, 'binary').toString('base64'),
  (text) => Buffer.from(text, 'base64').toString('binary'),
  console,
)

const ctx = {
  effect(register) {
    const dispose = register()
    return typeof dispose === 'function' ? dispose : () => {}
  },
  get(name) {
    if (name === 'conversation') return conversationService
    if (name === 'uiConversation') return { events: { register() { return () => {} } } }
    return undefined
  },
  inject(names, callback) {
    callback({ get: () => undefined })
  },
  slots: {
    inject(seat, mount) {
      const dispose = mount()
      return typeof dispose === 'function' ? dispose : () => {}
    },
    register() {
      return () => {}
    },
  },
  logger() {
    return { warn() {}, info() {} }
  },
}
factory.apply(ctx)

const T = factory.__test

/* ------------------------------------------------------------ harness --- */

const results = []
const check = (name, ok, detail) => {
  results.push({ name: name, ok: Boolean(ok), detail: String(detail === undefined ? '' : detail) })
}

let container = null
let root = null

async function mount(element) {
  container = win.document.createElement('div')
  win.document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => {
    root.render(element)
  })
  return container
}

async function unmount() {
  const current = root
  root = null
  if (current !== null) {
    await act(async () => {
      current.unmount()
    })
  }
  if (container !== null) {
    container.remove()
    container = null
  }
  win.document.body.innerHTML = ''
  calls.length = 0
}

async function click(element) {
  await act(async () => {
    element.dispatchEvent(new win.MouseEvent('click', { bubbles: true }))
  })
}

const buttonByText = (scope, text) =>
  Array.from(scope.querySelectorAll('button')).find((button) => button.textContent.trim() === text) || null

async function typeInto(textarea, value) {
  const descriptor = Object.getOwnPropertyDescriptor(win.HTMLTextAreaElement.prototype, 'value')
  await act(async () => {
    descriptor.set.call(textarea, value)
    textarea.dispatchEvent(new win.Event('input', { bubbles: true }))
  })
}

const userBlocks = [
  { type: 'text', text: '看看这张图和笔记' },
  { type: 'image', attachment: { attachmentId: 'a1', mediaType: 'image/png', name: 'map.png' } },
  { type: 'file', attachment: { attachmentId: 'a2', mediaType: 'text/markdown', name: 'notes.md' } },
]

const userRow = () =>
  React.createElement(T.UserActionsRow, {
    node: {
      key: '15:rewind-actionsu1',
      kind: 'rewind-actions',
      anchorSeq: 2,
      data: { seq: 2, messageId: 'u1', content: userBlocks },
    },
    sessionId: 's1',
    inputActions: inputActions,
    t: (key) => key,
  })

const lastCall = (op) => {
  for (let index = calls.length - 1; index >= 0; index -= 1) {
    if (calls[index].op === op) return calls[index]
  }
  return null
}

/* ---------------------------------------------------------- edit flow --- */

const box = await mount(userRow())
check('action row has 编辑', buttonByText(box, '编辑') !== null, box.textContent)
await click(buttonByText(box, '编辑'))

const dialog = win.document.querySelector('.dsh-rw-dialog')
check('edit dialog opens', dialog !== null, '')
check('dialog lives on document.body, outside the scroll container', dialog !== null && dialog.parentNode !== null && dialog.parentNode.parentNode === win.document.body, dialog && dialog.parentNode && dialog.parentNode.className)
check('dialog is not a descendant of the message row', dialog !== null && !box.contains(dialog), '')
const textarea = win.document.querySelector('textarea')
check('edit dialog prefilled with original text', textarea !== null && textarea.value === '看看这张图和笔记', textarea && textarea.value)
const chips = Array.from(win.document.querySelectorAll('.dsh-rw-file')).map((chip) => chip.textContent)
check('edit dialog lists both attachments', chips.length === 2, chips.join(' | '))
check('edit dialog names attachments', chips.join(' ').includes('map.png') && chips.join(' ').includes('notes.md'), chips.join(' | '))

await typeInto(textarea, '改成新的问题')

const notesChip = Array.from(win.document.querySelectorAll('.dsh-rw-file')).find((chip) => chip.textContent.includes('notes.md'))
const removeButton = notesChip.querySelector('.dsh-rw-file-remove')
await click(removeButton)
const remaining = Array.from(win.document.querySelectorAll('.dsh-rw-file')).map((chip) => chip.textContent)
check('removing a chip leaves the other one', remaining.length === 1 && remaining[0].includes('map.png'), remaining.join(' | '))

const fileInput = win.document.querySelector('input[type=file]')
const extraFile = new win.File(['extra'], 'extra.png', { type: 'image/png' })
Object.defineProperty(fileInput, 'files', { value: [extraFile], configurable: true })
await act(async () => {
  fileInput.dispatchEvent(new win.Event('change', { bubbles: true }))
})
const afterAdd = Array.from(win.document.querySelectorAll('.dsh-rw-file')).map((chip) => chip.textContent)
check('added file shows up as a chip', afterAdd.length === 2 && afterAdd.join(' ').includes('extra.png'), afterAdd.join(' | '))

const saveButton = buttonByText(win.document.body, '保存并重新发送')
check('save button present', saveButton !== null, '')
await click(saveButton)

const uploadCall = lastCall('upload')
const editCall = lastCall('edit')
check('edit uploads the new file first', uploadCall !== null && uploadCall.body.name === 'extra.png', uploadCall && JSON.stringify(uploadCall.body).slice(0, 120))
check('edit keeps the untouched attachment', editCall !== null && JSON.stringify(editCall.body.keep) === '["a1"]', editCall && JSON.stringify(editCall.body.keep))
check('edit sends the new text', editCall !== null && editCall.body.text === '改成新的问题', editCall && editCall.body.text)
check('edit sends the uploaded block', editCall !== null && editCall.body.add.length === 1 && editCall.body.add[0].attachment.attachmentId === 'new-a', editCall && JSON.stringify(editCall.body.add))
check('edit targets the right message', editCall !== null && editCall.body.seq === 2 && editCall.body.sessionId === 's1', editCall && JSON.stringify({ seq: editCall.body.seq, sid: editCall.body.sessionId }))
check('edit dialog closes after save', win.document.querySelector('.dsh-rw-dialog') === null, '')
check('edit toast confirms', win.document.body.textContent.includes('已保存并重新发送'), win.document.body.textContent)
await unmount()

/* -------------------------------------------------------- recall flow --- */

const recallBox = await mount(userRow())
await click(buttonByText(recallBox, '撤回'))
const recallDialog = win.document.querySelector('.dsh-rw-dialog')
check('recall dialog opens', recallDialog !== null, '')
check('recall dialog explains consequence', recallDialog !== null && recallDialog.textContent.includes('模型上下文中移除'), recallDialog && recallDialog.textContent.slice(0, 80))
await click(win.document.querySelector('.dsh-rw-danger'))
const recallCall = lastCall('recall')
check('recall hits the host', recallCall !== null && recallCall.body.seq === 2, recallCall && JSON.stringify(recallCall.body))
check('recall dialog closes', win.document.querySelector('.dsh-rw-dialog') === null, '')
check('recall toast reports count', win.document.body.textContent.includes('已撤回，模型上下文里移除了 3 条内容'), win.document.body.textContent)
await unmount()

/* ---------------------------------------------------- escape + cancel --- */

const escapeBox = await mount(userRow())
await click(buttonByText(escapeBox, '编辑'))
check('dialog open before escape', win.document.querySelector('.dsh-rw-dialog') !== null, '')
await act(async () => {
  win.document.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
})
check('escape closes the dialog', win.document.querySelector('.dsh-rw-dialog') === null, '')
await unmount()

/* -------------------------------------------------------- resend flow --- */

const resendBox = await mount(userRow())
await click(buttonByText(resendBox, '重发'))
check('resend restores the text', inputActions.drafts.length === 1 && inputActions.drafts[0] === '看看这张图和笔记', inputActions.drafts.join(' | '))
check('resend rebuilds every attachment', conversationCalls.drafts.length === 1 && conversationCalls.drafts[0].names.length === 2, JSON.stringify(conversationCalls.drafts))
check('resend puts attachment ids into the composer', inputActions.attachments.length === 1 && inputActions.attachments[0].length === 2, JSON.stringify(inputActions.attachments))
const toast = win.document.body.querySelector('.dsh-rw-toast')
check('resend toast names text and attachments', toast !== null && toast.textContent.includes('已放回输入框：文字、2 个附件'), toast && toast.textContent)
const sendNowButton = toast && toast.querySelector('.dsh-rw-toast-action')
check('resend toast offers 立即发送', sendNowButton !== null && sendNowButton.textContent === '立即发送', sendNowButton && sendNowButton.textContent)
await click(sendNowButton)
await act(async () => {
  await new Promise((resolve) => win.setTimeout(resolve, 320))
})
check('立即发送 submits the composer', inputActions.submits === 1, inputActions.submits)
await unmount()

/* ------------------------------------------------- assistant actions --- */

const snapshot = {
  nodes: new Map([
    ['13:input-messageu1', { key: '13:input-messageu1', kind: 'user', anchorSeq: 2, data: { seq: 2, messageId: 'u1', content: userBlocks } }],
    ['16:assistant-stepm1', { key: '16:assistant-stepm1', kind: 'assistant-step', anchorSeq: 4, data: { finalNode: { messageId: 'm1', seq: 4 } } }],
  ]),
  order: [],
}
const useChat = (selector) => selector(snapshot)
const assistantBox = await mount(
  React.createElement(T.AssistantActions, { messageId: 'm1', sessionId: 's1', useChat: useChat, t: (key) => key }),
)
const icons = assistantBox.querySelectorAll('button')
check('assistant row has two icon buttons', icons.length === 2, icons.length)
await click(icons[0])
const regenCall = lastCall('regenerate')
check('regenerate hits the host with the assistant seq', regenCall !== null && regenCall.body.seq === 4, regenCall && JSON.stringify(regenCall.body))
await click(icons[1])
check('assistant recall opens a dialog', win.document.querySelector('.dsh-rw-dialog') !== null, '')
check('assistant recall dialog says 撤回这条回复', win.document.body.textContent.includes('撤回这条回复'), '')
await unmount()

/* -------------------------------------------------------- marker row --- */

const markerSnapshot = {
  nodes: new Map([
    ['13:input-messageu1', { key: '13:input-messageu1', kind: 'user', anchorSeq: 2, data: { seq: 2, messageId: 'u1', content: userBlocks } }],
    ['16:assistant-stepm1', { key: '16:assistant-stepm1', kind: 'assistant-step', anchorSeq: 4, data: { finalNode: { messageId: 'm1', seq: 4 } } }],
    ['15:rewind-marker9', { key: '15:rewind-marker9', kind: 'rewind-marker', anchorSeq: 9, data: { kind: 'recall', startSeq: 2, endSeq: 9, shadowed: [2, 4] } }],
  ]),
  order: [],
}
const markerUseChat = (selector) => selector(markerSnapshot)
const markerBox = await mount(
  React.createElement(T.MarkerRow, {
    node: markerSnapshot.nodes.get('15:rewind-marker9'),
    sessionId: 's1',
    useChat: markerUseChat,
    inputActions: inputActions,
    t: (key) => key,
  }),
)
check('marker explains the recall', markerBox.textContent.includes('已撤回'), markerBox.textContent)
check('marker offers 放回输入框', buttonByText(markerBox, '放回输入框') !== null, markerBox.textContent)
const hideTag = win.document.getElementById('dsh-rewind-hide')
check('marker publishes hide rules', hideTag !== null && hideTag.textContent.includes('13:input-messageu1'), hideTag && hideTag.textContent.slice(0, 120))
check('hide rules cover the assistant row too', hideTag !== null && hideTag.textContent.includes('16:assistant-stepm1'), hideTag && hideTag.textContent.slice(0, 200))
inputActions.drafts.length = 0
inputActions.attachments.length = 0
conversationCalls.drafts.length = 0
await click(buttonByText(markerBox, '放回输入框'))
check('marker refill restores text', inputActions.drafts[0] === '看看这张图和笔记', inputActions.drafts.join(' | '))
check('marker refill restores attachments', conversationCalls.drafts.length === 1 && conversationCalls.drafts[0].names.length === 2, JSON.stringify(conversationCalls.drafts))
await unmount()

/* -------------------------------------------------------------- report --- */

const failed = results.filter((item) => !item.ok)
for (const item of results) console.log((item.ok ? 'ok   ' : 'FAIL ') + item.name + (item.ok ? '' : '  <<< ' + item.detail))
console.log('')
console.log('INTERACT ' + (failed.length === 0 ? 'OK' : 'FAILED') + ' (' + results.length + ' checks, ' + failed.length + ' failed)')
process.exit(failed.length === 0 ? 0 : 1)