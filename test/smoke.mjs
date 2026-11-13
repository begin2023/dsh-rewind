
import fs from 'node:fs'

const code = fs.readFileSync('/Users/youngwu/Documents/code/dsh-rewind/client.js', 'utf8')

const created = []
const headChildren = []
const document = {
  head: { appendChild(node) { headChildren.push(node); node.parentNode = this } },
  body: { appendChild() {}, },
  createElement(tag) {
    const node = { tagName: tag, id: '', textContent: '', parentNode: null, remove() {}, setAttribute() {}, appendChild() {} }
    created.push(node)
    return node
  },
  getElementById(id) {
    const found = created.find((node) => node.id === id)
    return found === undefined ? null : found
  },
  addEventListener() {},
  removeEventListener() {},
}

const React = {
  createElement(type, props, ...children) { return { type, props: props || {}, children } },
  useEffect() {},
  useMemo(fn) { return fn() },
  useRef() { return { current: null } },
  useState(initial) { return [initial, () => {}] },
}

let factoryResult = null
const window = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (id) => clearTimeout(id),
  __ModuleLoader__: {
    load(spec) {
      factoryResult = spec.factory((name) => {
        if (name === 'react') return React
        throw new Error('unexpected require: ' + name)
      })
      factoryResult.__id = spec.id
    },
  },
}

const run = new Function('window', 'document', 'fetch', 'File', 'btoa', 'atob', 'console', code)
run(window, document, () => { throw new Error('fetch should not run') }, class File {}, (s) => Buffer.from(s, 'binary').toString('base64'), (s) => Buffer.from(s, 'base64').toString('binary'), console)

const results = []
const check = (name, ok, detail) => results.push({ name, ok: Boolean(ok), detail })

check('module id', factoryResult !== null && factoryResult.__id === 'dsh-rewind', String(factoryResult && factoryResult.__id))
check('module inject', Array.isArray(factoryResult.inject) && factoryResult.inject.includes('slots'))
check('apply exported', typeof factoryResult.apply === 'function')

const definitions = []
const slots = []
const effects = []
const fakeUiConversation = { events: { register(definition) { definitions.push(definition); return () => {} } } }
const ctx = {
  effect(fn, label) { effects.push(label); const dispose = fn(); return dispose || (() => {}) },
  get(name) {
    if (name === 'uiConversation') return fakeUiConversation
    if (name === 'conversation') return { createDrafts() { return [] } }
    if (name === 'sessions') return { get() { return undefined } }
    return undefined
  },
  inject(names, cb) { cb({ get: (name) => (name === 'uiConversation' ? fakeUiConversation : undefined) }) },
  slots: {
    inject(seat, cb) { const dispose = cb(); return dispose || (() => {}) },
    register(options, component) { slots.push({ options, component }); return () => {} },
  },
  logger() { return { warn() {}, info() {} } },
}

factoryResult.apply(ctx)

check('definitions registered', definitions.length === 2, definitions.map((d) => d.kind).join(','))
check('slot registrations', slots.length === 4, slots.map((s) => s.options.name + '/' + (s.options.key || s.options.id)).join(' | '))
check('style injected', created.some((node) => node.id === 'dsh-rewind-style' && node.textContent.length > 500))
check('effects', effects.length >= 2, effects.join(','))

const test = factoryResult.__test
check('nodeKeyId', test.nodeKeyId('13:input-messageabc123') === 'abc123', test.nodeKeyId('13:input-messageabc123'))
check('nodeKeyId bad', test.nodeKeyId('nope') === null)

const userEvent = { seq: 2, type: 'user/message', data: { id: 'm1', content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } } }
const matched = test.actionsDefinition.match(userEvent)
check('actions match append', matched && matched.id === 'm1' && matched.role === 'start')
check('actions skip replacement', test.actionsDefinition.match({ ...userEvent, surfaceOp: { op: 'replace', startSeq: 1, endSeq: 2 } }) === null)
check('actions skip assistant', test.actionsDefinition.match({ seq: 3, type: 'assistant/message', data: { id: 'a1', content: [] } }) === null)
check('actions skip tool source', test.actionsDefinition.match({ ...userEvent, data: { ...userEvent.data, source: { kind: 'tool' } } }) === null)

const node = test.actionsDefinition.buildViewNode({ key: '15:rewind-actionsm1', id: 'm1', state: { seq: 2 } })
check('actions node location', node.location.kind === 'unresolved' && node.anchorSeq === 2 && node.target === 'chat')
check('actions node kind', node.kind === 'rewind-actions')

const markerEvent = { seq: 9, type: 'system/message', surfaceOp: { op: 'replace', startSeq: 2, endSeq: 3 }, sourceEventSeqs: [2, 3], data: { message: { id: 'rewind:recall:xyz' } } }
check('marker match', Boolean(test.markerDefinition.match(markerEvent)))
check('marker skips append', test.markerDefinition.match({ ...markerEvent, surfaceOp: 'append' }) === null)
check('marker skips other system', test.markerDefinition.match({ ...markerEvent, data: { message: { id: 'sys-1' } } }) === null)
const markerState = test.markerDefinition.start({}, { event: markerEvent })
check('marker start state', markerState.kind === 'recall' && markerState.startSeq === 2 && markerState.shadowed.length === 2)
const markerNode = test.markerDefinition.buildViewNode({ key: '13:rewind-marker9', id: '9', state: markerState })
check('marker node', markerNode.anchorSeq === 9 && markerNode.location.kind === 'unresolved')

const nodes = new Map()
nodes.set('13:input-messageu1', { key: '13:input-messageu1', kind: 'user', anchorSeq: 2, visibility: 'visible', data: { seq: 2, turn: 1 }, location: { turn: { turn: 1 } } })
nodes.set('15:assistant-stepa1', { key: '15:assistant-stepa1', kind: 'assistant-step', anchorSeq: 3, visibility: 'visible', data: { turn: 1, finalNode: { seq: 3 } }, location: { turn: { turn: 1 } } })
nodes.set('12:turn-process1', { key: '12:turn-process1', kind: 'turn-process', anchorSeq: 1, visibility: 'visible', data: { turn: 1 }, location: { turn: { turn: 1 } } })
nodes.set('9:turn-tail1', { key: '9:turn-tail1', kind: 'turn-tail', anchorSeq: 4, visibility: 'visible', data: { turn: 1, closing: { finalNode: { seq: 3 } } }, location: { turn: { turn: 1 } } })
nodes.set('15:rewind-actionsu1', { key: '15:rewind-actionsu1', kind: 'rewind-actions', anchorSeq: 2, visibility: 'visible', data: { seq: 2 }, location: { kind: 'unresolved' } })

const keys = test.hiddenKeysFor([2, 3], nodes)
check('hidden keys cover rows', keys !== null && keys.includes('13:input-messageu1') && keys.includes('15:assistant-stepa1'), String(keys))
check('hidden keys hide the action row of a hidden message', keys !== null && keys.includes('15:rewind-actionsu1'), String(keys))
check('hidden keys fold turn header', keys !== null && keys.includes('12:turn-process1'), String(keys))
check('hidden keys partial turn keeps header', test.hiddenKeysFor([2], nodes).indexOf('12:turn-process1') < 0)

const css = test.hideCss([2, 3], { nodes })
check('hide css has rules', css.includes('data-chat-node-key="13:input-messageu1"') && css.includes('display:none!important'), css.slice(0, 120))
check('hide css empty for none', test.hideCss([], { nodes }) === '')

const snapshotNodes = new Map()
snapshotNodes.set('13:rewind-marker9', { key: '13:rewind-marker9', kind: 'rewind-marker', anchorSeq: 9, visibility: 'visible', data: { shadowed: [2, 3] }, location: { kind: 'unresolved' } })
for (const entry of nodes) snapshotNodes.set(entry[0], entry[1])
const autoCss = test.hideCss(null, { nodes: snapshotNodes })
check('controller css from markers', autoCss.includes('13:input-messageu1'), autoCss.slice(0, 80))

check('textOfBlocks', test.textOfBlocks([{ type: 'text', text: 'a' }, { type: 'image' }, { type: 'text', text: 'b' }]) === 'a\nb')

const failed = results.filter((item) => !item.ok)
for (const item of results) console.log((item.ok ? 'PASS ' : 'FAIL ') + item.name + (item.ok ? '' : ' -> ' + item.detail))
console.log(failed.length === 0 ? 'SMOKE OK (' + results.length + ' checks)' : 'SMOKE FAILED (' + failed.length + '/' + results.length + ')')
process.exit(failed.length === 0 ? 0 : 1)
