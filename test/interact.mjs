import fs from 'node:fs'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { JSDOM } = require('jsdom')

const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>', {
  url: 'http://127.0.0.1/',
  pretendToBeVisual: true,
})
const win = dom.window

// jsdom omits Blob.arrayBuffer; provide the browser API through its FileReader.
if (typeof win.Blob.prototype.arrayBuffer !== 'function') {
  win.Blob.prototype.arrayBuffer = function () {
    return new Promise((resolve, reject) => {
      const reader = new win.FileReader()
      reader.onload = () => resolve(reader.result)
      reader.onerror = () => reject(reader.error)
      reader.readAsArrayBuffer(this)
    })
  }
}

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
  if (op === 'edit') return { shadowed: 3, truncated: 2 }
  if (op === 'regenerate') return { shadowed: 2 }
  return {}
}

let hostHandler = hostValue
let pendingHostRequests = 0

const fetchStub = async (url, init) => {
  const target = String(url)
  const op = target.slice(target.lastIndexOf('/') + 1)
  const body = init && typeof init.body === 'string' ? JSON.parse(init.body) : {}
  calls.push({ op: op, body: body })
  pendingHostRequests += 1
  let value
  try {
    value = await hostHandler(op, body)
  } finally {
    pendingHostRequests -= 1
  }
  const payload = { ok: true, value: value }
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

const source = fs.readFileSync(new URL('../client.js', import.meta.url), 'utf8')
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

async function waitFor(condition) {
  const deadline = Date.now() + 2000
  await act(async () => {
    while (!condition()) {
      if (Date.now() >= deadline) throw new Error('Timed out waiting for asynchronous UI')
      await new Promise(resolve => win.setTimeout(resolve, 5))
    }
  })
}

function deferred() {
  let resolve
  const promise = new Promise((done) => { resolve = done })
  return { promise: promise, resolve: resolve }
}

async function flushAsync() {
  await act(async () => {
    await new Promise((resolve) => setImmediate(resolve))
  })
}

async function releaseHost(gate) {
  await act(async () => { gate.resolve() })
  await waitFor(() => pendingHostRequests === 0)
  await flushAsync()
}

async function selectFiles(input, files) {
  Object.defineProperty(input, 'files', { value: files, configurable: true })
  await act(async () => {
    input.dispatchEvent(new win.Event('change', { bubbles: true }))
  })
}

async function sendFiles(target, type, property, files) {
  const event = new win.Event(type, { bubbles: true, cancelable: true })
  Object.defineProperty(event, property, { value: { files: files } })
  await act(async () => { target.dispatchEvent(event) })
}

const chipNames = (scope) => Array.from(scope.querySelectorAll('.dsh-rw-file-name'), (chip) => chip.textContent)
const countCalls = (op) => calls.filter((call) => call.op === op).length

function resetComposer() {
  inputActions.drafts.length = 0
  inputActions.attachments.length = 0
  inputActions.submits = 0
  conversationCalls.drafts.length = 0
  conversationCalls.released.length = 0
}

// Hold the composer's next short upload-settle delay; toast timers remain real.
function pauseComposerDelay() {
  const original = win.setTimeout
  let resume = null
  win.setTimeout = function (callback, delay, ...args) {
    if (delay === 80 && resume === null) {
      resume = () => callback(...args)
      return 0
    }
    return original.call(win, callback, delay, ...args)
  }
  return {
    get paused() { return resume !== null },
    release() {
      win.setTimeout = original
      const callback = resume
      resume = null
      if (callback !== null) callback()
    },
  }
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
check('action row only has 编辑', box.querySelectorAll('button').length === 1 && buttonByText(box, '重发') === null && buttonByText(box, '撤回') === null, box.textContent)
await click(buttonByText(box, '编辑'))

const dialog = win.document.querySelector('.dsh-rw-dialog')
check('edit dialog opens', dialog !== null, '')
const dialogName = dialog && (dialog.getAttribute('aria-label') ||
  (dialog.getAttribute('aria-labelledby') || '').split(/\s+/).map((id) => {
    const label = win.document.getElementById(id)
    return label ? label.textContent : ''
  }).join(' '))
check('edit dialog has an accessible name', dialogName && dialogName.trim() === '编辑消息', dialogName)
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
await waitFor(() => win.document.querySelector('.dsh-rw-dialog') === null)

const editCall = lastCall('edit')
check('edit does not create a standalone upload request', calls.filter((call) => call.op === 'upload').length === 0, JSON.stringify(calls))
check('edit keeps the untouched attachment', editCall !== null && JSON.stringify(editCall.body.keep) === '["a1"]', editCall && JSON.stringify(editCall.body.keep))
check('edit sends the new text', editCall !== null && editCall.body.text === '改成新的问题', editCall && editCall.body.text)
check('edit sends the new file as a transactional upload spec', editCall !== null && editCall.body.add.length === 1 && editCall.body.add[0].upload.name === 'extra.png' && editCall.body.add[0].upload.data === 'ZXh0cmE=', editCall && JSON.stringify(editCall.body.add))
check('edit targets the right message', editCall !== null && editCall.body.seq === 2 && editCall.body.sessionId === 's1', editCall && JSON.stringify({ seq: editCall.body.seq, sid: editCall.body.sessionId }))
check('edit dialog closes after save', win.document.querySelector('.dsh-rw-dialog') === null, '')
check('edit toast confirms', win.document.body.textContent.includes('已保存并重新发送'), win.document.body.textContent)
await unmount()

/* ---------------------------------------------------- busy edit guards --- */

const editsBeforeBusy = countCalls('edit')
const editGate = deferred()
hostHandler = async (op) => {
  if (op === 'edit') await editGate.promise
  return hostValue(op)
}
const busyHandle = T.openEditDialog({ sessionId: 's1', seq: 2, blocks: [userBlocks[0], userBlocks[2]] })
const busyDialog = busyHandle.card
const busyText = busyDialog.querySelector('textarea')
const busyPicker = busyDialog.querySelector('input[type=file]')
const savedText = '  保存快照：中文 👩🏽‍💻 é\n第二行  '
await typeInto(busyText, savedText)
await selectFiles(busyPicker, [
  new win.File(['A'], 'A.txt', { type: 'text/plain' }),
  new win.File(['B'], 'B.txt', { type: 'text/plain' }),
])
const busySave = buttonByText(busyDialog, '保存并重新发送')
await click(busySave)
await waitFor(() => countCalls('edit') === editsBeforeBusy + 1)
check('busy edit disables the textarea', busyText.disabled, '')
check('busy edit disables the file picker', busyPicker.disabled, '')
check('busy edit disables every button', Array.from(busyDialog.querySelectorAll('button')).every((button) => button.disabled), busyDialog.innerHTML)
const selectedNames = chipNames(busyDialog)
const busyRemove = Array.from(busyDialog.querySelectorAll('.dsh-rw-file')).find((chip) => chip.textContent.includes('A.txt')).querySelector('button')
// dispatchEvent also verifies handlers reject late input already queued before disabling.
await click(busyRemove)
check('busy remove leaves selected attachments unchanged', JSON.stringify(chipNames(busyDialog)) === JSON.stringify(selectedNames), chipNames(busyDialog))
await sendFiles(busyDialog, 'drop', 'dataTransfer', [new win.File(['drop'], 'dropped.txt', { type: 'text/plain' })])
check('busy drop cannot add attachments', JSON.stringify(chipNames(busyDialog)) === JSON.stringify(selectedNames), chipNames(busyDialog))
await sendFiles(busyText, 'paste', 'clipboardData', [new win.File(['paste'], 'pasted.txt', { type: 'text/plain' })])
check('busy paste cannot add attachments', JSON.stringify(chipNames(busyDialog)) === JSON.stringify(selectedNames), chipNames(busyDialog))
await selectFiles(busyPicker, [new win.File(['change'], 'changed.txt', { type: 'text/plain' })])
check('busy file change cannot add attachments', JSON.stringify(chipNames(busyDialog)) === JSON.stringify(selectedNames), chipNames(busyDialog))
await act(async () => {
  win.document.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
})
check('busy Escape cannot dismiss the dialog', busyDialog.isConnected, '')
await act(async () => {
  busyDialog.parentNode.dispatchEvent(new win.MouseEvent('mousedown', { bubbles: true }))
})
check('busy backdrop cannot dismiss the dialog', busyDialog.isConnected, '')
await click(busySave)
await act(async () => {
  busyText.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true, cancelable: true }))
})
check('busy repeated save does not start another edit', countCalls('edit') === editsBeforeBusy + 1, JSON.stringify(calls))
// A disabled control can still be changed by scripts; the pending submission owns its original snapshot.
await typeInto(busyText, '较晚的程序修改')
await releaseHost(editGate)
await waitFor(() => !busyDialog.isConnected)
const busyEdit = lastCall('edit')
check('busy save submits once', countCalls('edit') === editsBeforeBusy + 1, JSON.stringify(calls))
check('busy save preserves the exact text snapshot including Unicode and whitespace', busyEdit && busyEdit.body.text === savedText, busyEdit && busyEdit.body.text)
check('busy save preserves retained attachments', busyEdit && JSON.stringify(busyEdit.body.keep) === '["a2"]', busyEdit && JSON.stringify(busyEdit.body.keep))
check('busy save sends both selected new files as upload specs exactly once', JSON.stringify(busyEdit && busyEdit.body.add.map((block) => block.upload.name)) === '["A.txt","B.txt"]', busyEdit && JSON.stringify(busyEdit.body.add))
check('busy save makes no standalone upload calls', calls.filter((call) => call.op === 'upload').length === 0, JSON.stringify(calls))
hostHandler = hostValue
await unmount()

/* ---------------------------------------------------- forced close guard --- */

const closedEditGate = deferred()
const editsBeforeClose = countCalls('edit')
hostHandler = async (op) => {
  if (op === 'edit') await closedEditGate.promise
  return hostValue(op)
}
const closedHandle = T.openEditDialog({ sessionId: 's1', seq: 2, blocks: [userBlocks[0]] })
await selectFiles(closedHandle.card.querySelector('input[type=file]'), [new win.File(['late'], 'late.txt', { type: 'text/plain' })])
await click(buttonByText(closedHandle.card, '保存并重新发送'))
await waitFor(() => countCalls('edit') === editsBeforeClose + 1)
await act(async () => { T.closeAllDialogs() })
check('closeAllDialogs force-closes a busy edit', !closedHandle.card.isConnected, '')
await releaseHost(closedEditGate)
check('a force-closed edit does not announce a successful edit', !win.document.body.textContent.includes('已保存并重新发送'), win.document.body.textContent)
hostHandler = hostValue
await unmount()

/* ---------------------------------------------------- composition guard --- */

const imeHandle = T.openEditDialog({ sessionId: 's1', seq: 2, blocks: [{ type: 'text', text: '初始文本' }] })
const imeText = imeHandle.card.querySelector('textarea')
await typeInto(imeText, 'han')
await act(async () => {
  for (const modifier of ['ctrlKey', 'metaKey']) {
    imeText.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Enter', [modifier]: true, isComposing: true, bubbles: true, cancelable: true }))
  }
  imeText.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, keyCode: 229, bubbles: true, cancelable: true }))
})
await flushAsync()
check('IME Ctrl/Meta+Enter and legacy composition events do not submit', countCalls('edit') === 0 && imeHandle.card.isConnected, JSON.stringify(calls))
await typeInto(imeText, '汉字完成 👩🏽‍💻')
await act(async () => {
  imeText.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true, cancelable: true }))
})
await waitFor(() => !imeHandle.card.isConnected)
check('normal Ctrl+Enter submits once after composition', countCalls('edit') === 1 && lastCall('edit').body.text === '汉字完成 👩🏽‍💻', JSON.stringify(calls))
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

/* -------------------------------------------------------- unchanged edit --- */

const unchangedBox = await mount(userRow())
await click(buttonByText(unchangedBox, '编辑'))
const editCountBefore = calls.filter((call) => call.op === 'edit').length
await click(buttonByText(win.document.body, '保存并重新发送'))
const unchangedEdit = lastCall('edit')
check('unchanged edit still submits', calls.filter((call) => call.op === 'edit').length === editCountBefore + 1, calls.length)
check('unchanged edit sends original text', unchangedEdit.body.text === userBlocks[0].text, unchangedEdit.body.text)
check('unchanged edit keeps every attachment', JSON.stringify(unchangedEdit.body.keep) === '["a1","a2"]', JSON.stringify(unchangedEdit.body.keep))
check('unchanged edit adds no attachments', unchangedEdit.body.add.length === 0, JSON.stringify(unchangedEdit.body.add))
check('unchanged edit dialog closes', win.document.querySelector('.dsh-rw-dialog') === null, '')
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
check('assistant row only has regeneration', icons.length === 1 && icons[0].title === '重新生成这条回复', assistantBox.innerHTML)
await click(icons[0])
const regenCall = lastCall('regenerate')
check('regenerate hits the host with the assistant seq', regenCall !== null && regenCall.body.seq === 4, regenCall && JSON.stringify(regenCall.body))
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
check('marker refill puts attachment ids into the composer', inputActions.attachments.length === 1 && inputActions.attachments[0].length === 2, JSON.stringify(inputActions.attachments))
const toast = win.document.body.querySelector('.dsh-rw-toast')
check('marker refill toast names text and attachments', toast !== null && toast.textContent.includes('已放回输入框：文字、2 个附件'), toast && toast.textContent)
const sendNowButton = toast && toast.querySelector('.dsh-rw-toast-action')
check('marker refill toast offers 立即发送', sendNowButton !== null && sendNowButton.textContent === '立即发送', sendNowButton && sendNowButton.textContent)
await click(sendNowButton)
await waitFor(() => inputActions.submits === 1)
check('立即发送 submits the composer', inputActions.submits === 1, inputActions.submits)
await unmount()

/* -------------------------------------------------------------- report --- */

const failed = results.filter((item) => !item.ok)
for (const item of results) console.log((item.ok ? 'ok   ' : 'FAIL ') + item.name + (item.ok ? '' : '  <<< ' + item.detail))
console.log('')
console.log('INTERACT ' + (failed.length === 0 ? 'OK' : 'FAILED') + ' (' + results.length + ' checks, ' + failed.length + ' failed)')
process.exit(failed.length === 0 ? 0 : 1)