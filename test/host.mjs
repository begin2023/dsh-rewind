import { apply } from '../index.js'

const results = []
const check = (name, ok, detail) => {
  results.push({ name: name, ok: Boolean(ok), detail: String(detail === undefined ? '' : detail) })
}

/* ------------------------------------------------------------- session --- */

const SURFACE_TYPES = {
  'system/message': true,
  'developer/message': true,
  'user/message': true,
  'assistant/message': true,
  'tool/result': true,
}

function makeSession() {
  const events = []
  const nodes = []
  const session = {
    events: events,
    surface: { get nodes() { return nodes } },
    append(type, data, opts) {
      const seq = events.length === 0 ? 0 : events[events.length - 1].seq + 1
      const event = { seq: seq, type: type, data: data, time: 1000 + seq }
      if (opts && opts.surfaceOp) {
        event.surfaceOp = opts.surfaceOp
        event.sourceEventSeqs = opts.sourceEventSeqs
      }
      events.push(event)
      if (opts && opts.surfaceOp && opts.surfaceOp.op === 'replace') {
        const start = nodes.indexOf(opts.surfaceOp.startSeq)
        const end = nodes.indexOf(opts.surfaceOp.endSeq)
        if (start < 0 || end < 0) throw new Error('surface replace: seq not found')
        nodes.splice(start, end - start + 1, seq)
      } else if (SURFACE_TYPES[type] === true) {
        nodes.push(seq)
      }
      return event
    },
    eventAt(seq) {
      return events.find((event) => event.seq === seq)
    },
    snapshotEvents() {
      return events.slice()
    },
  }

  session.append('system/message', {
    turn: 0,
    step: 0,
    message: { id: 'sys', role: 'system', content: [{ type: 'text', text: 'you are helpful' }], source: { kind: 'system-prompt' } },
  })
  session.append('turn/start', { turn: 1 })
  session.append('step/start', { turn: 1, step: 1 })
  session.append('user/message', {
    id: 'u1',
    role: 'user',
    content: [
      { type: 'text', text: '看看这张图和笔记' },
      { type: 'image', attachment: { attachmentId: 'a1', mediaType: 'image/png', name: 'map.png' } },
      { type: 'file', attachment: { attachmentId: 'a2', mediaType: 'text/markdown', name: 'notes.md' } },
    ],
    source: { kind: 'user', rpcId: 'r1' },
  })
  session.append('assistant/message', {
    message: { id: 'm1', role: 'assistant', content: [{ type: 'text', text: '好的' }], source: { kind: 'model', provider: 'p', model: 'm' } },
    turn: 1,
    step: 1,
  })
  session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  return session
}

function fixtureError(code, message) {
  return Object.assign(new Error(message), { code })
}

function deferred() {
  let resolve
  const promise = new Promise(done => { resolve = done })
  return { promise, resolve }
}

// Deadlines are milliseconds; a broken gate must fail rather than hang the suite.
async function bounded(promise, label, timeoutMs = 1000) {
  let timer
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(label + ' did not finish')), timeoutMs)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

function makeHost() {
  const host = {
    session: makeSession(),
    sent: [],
    pending: [],
    savedImages: [],
    savedFiles: [],
    deletedImages: [],
    deletedFiles: [],
    flushed: [],
    admissions: [],
    cancellations: [],
    idleCalls: 0,
    imageBudget: Infinity,
    onAdmit: null,
    onCancel: null,
    onFollowup: null,
    onWhenIdle: null,
    onFlush: null,
    fileStreamError: null,
    images: new Map([
      ['a1', { ref: { attachmentId: 'a1', name: 'map.png', mediaType: 'image/png' }, data: Buffer.from('png-bytes') }],
      ['a9', { ref: { attachmentId: 'a9', name: 'new.png', mediaType: 'image/png' }, data: Buffer.from('new-bytes') }],
    ]),
    files: new Map([['a2', Buffer.from('file-bytes')]]),
  }
  host.agent = {
    status: 'idle',
    inbox: { get hasPending() { return host.pending.length > 0 } },
    followup(message) {
      // Agent.followup enqueues synchronously, even though generation starts later.
      if (host.onFollowup) {
        const result = host.onFollowup(message)
        if (result !== undefined) return result
      }
      host.pending.push(message)
      host.sent.push(message)
    },
    cancel(reason, options) {
      host.cancellations.push({ reason, options })
      if (host.onCancel) return host.onCancel(reason, options)
      host.agent.status = 'idle'
    },
    whenIdle() {
      host.idleCalls += 1
      return host.onWhenIdle ? host.onWhenIdle() : Promise.resolve()
    },
  }
  host.attachments = {
    async admitPromptContent(content) {
      host.admissions.push(structuredClone(content))
      if (host.onAdmit) return host.onAdmit(content)
      const encodedBytes = content.reduce((sum, part) => sum + (part.type === 'image' ? part.encodedBytes || 0 : 0), 0)
      if (encodedBytes > host.imageBudget) throw fixtureError('image-budget-exceeded', 'aggregate image byte budget exceeded')
      return content
    },
    async readImage(ref) {
      const stored = host.images.get(ref.attachmentId)
      if (!stored) throw fixtureError('attachment-not-found', 'image is missing')
      // This is the real readImage contract, including its canonical metadata.
      return { ref: { ...stored.ref }, data: new Uint8Array(stored.data) }
    },
    async *readFileStream(ref) {
      const data = host.files.get(ref.attachmentId)
      if (!data) throw fixtureError('attachment-not-found', 'file is missing')
      yield data.subarray(0, 4)
      if (host.fileStreamError) throw host.fileStreamError
      yield data.subarray(4)
    },
    async saveImage(input) {
      host.savedImages.push(input)
      const ref = { attachmentId: 'new-img', mediaType: input.mediaType, name: input.name }
      host.images.set(ref.attachmentId, { ref, data: Buffer.from(input.data) })
      return ref
    },
    async saveFile(input) {
      host.savedFiles.push(input)
      const ref = { attachmentId: 'new-file', mediaType: 'text/plain', name: input.name }
      host.files.set(ref.attachmentId, Buffer.from(input.data))
      return ref
    },
    async deleteImage(ref) {
      host.deletedImages.push(ref)
    },
    async deleteFile(ref) {
      host.deletedFiles.push(ref)
    },
  }
  host.routes = {}
  const ctx = {
    effect(register) {
      const dispose = register()
      return typeof dispose === 'function' ? dispose : () => {}
    },
    get(name) {
      if (name === 'sessions') {
        return {
          get(id) { return id === 's1' ? host.session : undefined },
          async flush(target) {
            host.flushed.push(target)
            if (host.onFlush) await host.onFlush(target)
          },
        }
      }
      if (name === 'agents') return { get(id) { return id === 's1' ? host.agent : undefined } }
      if (name === 'attachments') return host.attachments
      return undefined
    },
    connection: {
      fetch: {
        register(options) {
          host.routes[options.path.slice('/api/dsh-rewind/'.length)] = options.fetch
          return () => {}
        },
      },
    },
    logger() { return { info() {}, warn() {} } },
  }
  apply(ctx)
  host.callRaw = async (op, text, options = {}) => {
    const handler = host.routes[op]
    if (!handler) throw new Error('route not registered: ' + op)
    const headerMap = new Map(Object.entries(options.headers || {}).map(([key, value]) => [key.toLowerCase(), String(value)]))
    const request = {
      headers: { get(name) { return headerMap.get(String(name).toLowerCase()) || null } },
      async text() { return text },
    }
    if (Array.isArray(options.chunks)) {
      let index = 0
      request.body = {
        getReader() {
          return {
            async read() {
              if (index >= options.chunks.length) return { done: true, value: undefined }
              return { done: false, value: options.chunks[index++] }
            },
            releaseLock() {},
          }
        },
      }
    }
    const response = await handler(request)
    return response.json()
  }
  host.call = (op, body) => host.callRaw(op, JSON.stringify(body === undefined ? {} : body))
  host.resetSession = () => {
    host.session = makeSession()
    host.sent.length = 0
    host.pending.length = 0
    host.agent.status = 'idle'
    host.imageBudget = Infinity
    host.onAdmit = null
    host.onCancel = null
    host.onFollowup = null
    host.onWhenIdle = null
    host.onFlush = null
    host.fileStreamError = null
  }
  return host
}

function mutationSnapshot(host) {
  return JSON.stringify({ events: host.session.events, nodes: host.session.surface.nodes, sent: host.sent, flushes: host.flushed.length })
}

const host = makeHost()
const { sent, savedImages, savedFiles, flushed, routes, call } = host
const lastAppend = () => host.session.events[host.session.events.length - 1]

/* ---------------------------------------------------------------- state --- */

check('only five routes registered without recall', Object.keys(routes).sort().join(',') === 'attachment,edit,regenerate,state,upload', Object.keys(routes).join(','))
const empty = await call('state', { sessionId: 's1' })
check('state starts empty', empty.ok === true && empty.value.entries.length === 0, JSON.stringify(empty))

const missing = await call('state', { sessionId: 'nope' })
check('unknown session is reported', missing.ok === false && missing.error.code === 'session-not-found', JSON.stringify(missing))

/* ----------------------------------------------------------------- edit --- */

const edited = await call('edit', {
  sessionId: 's1',
  seq: 3,
  text: '换成新问题',
  keep: ['a1'],
  add: [{ type: 'image', attachment: { attachmentId: 'a9', mediaType: 'image/png', name: 'new.png' } }],
})
check('edit succeeds', edited.ok === true, JSON.stringify(edited))

const marker = lastAppend()
check('edit appends a system/message marker', marker.type === 'system/message', marker.type)
check('marker id is namespaced', String(marker.data.message.id).startsWith('rewind:edit:'), marker.data.message.id)
check('marker content is empty so the model sees nothing', Array.isArray(marker.data.message.content) && marker.data.message.content.length === 0, JSON.stringify(marker.data.message.content))
check('marker replaces the edited message to the surface tail', JSON.stringify(marker.surfaceOp) === JSON.stringify({ op: 'replace', startSeq: 3, endSeq: 4 }), JSON.stringify(marker.surfaceOp))
check('marker lists every shadowed node', JSON.stringify(marker.sourceEventSeqs) === '[3,4]', JSON.stringify(marker.sourceEventSeqs))
check('edit flushed the session', flushed.length >= 1, flushed.length)

const sentMessage = sent[sent.length - 1]
check('edit resends through the agent', sent.length === 1 && sentMessage.role === 'user', sent.length)
check('edit text comes first', JSON.stringify(sentMessage.content[0]) === JSON.stringify({ type: 'text', text: '换成新问题' }), JSON.stringify(sentMessage.content[0]))
const keptBlocks = sentMessage.content.filter((block) => block.type !== 'text')
check('edit keeps the attachment that was not removed', keptBlocks.some((block) => block.attachment.attachmentId === 'a1'), JSON.stringify(keptBlocks))
check('edit drops the attachment the user removed', !keptBlocks.some((block) => block.attachment.attachmentId === 'a2'), JSON.stringify(keptBlocks))
check('edit appends the newly uploaded attachment', keptBlocks.some((block) => block.attachment.attachmentId === 'a9'), JSON.stringify(keptBlocks))
check('edit sends an admitted user message source', sentMessage.source.kind === 'user' && typeof sentMessage.source.rpcId === 'string', JSON.stringify(sentMessage.source))

const afterEdit = await call('state', { sessionId: 's1' })
const entry = afterEdit.value.entries[0]
check('state reports the edit fold', afterEdit.value.entries.length === 1 && entry.kind === 'edit', JSON.stringify(afterEdit.value.entries))
check('fold counts both shadowed messages', entry.count === 2, entry.count)
check('fold carries the shadowed seqs for the client', JSON.stringify(entry.shadowed) === '[3,4]', JSON.stringify(entry.shadowed))

const again = await call('edit', { sessionId: 's1', seq: 3, text: '再次修改' })
check('a shadowed message cannot be edited twice', again.ok === false && again.error.code === 'seq-not-in-surface', JSON.stringify(again))

/* ---------------------------------------------------------- regenerate --- */

host.resetSession()
const regenerated = await call('regenerate', { sessionId: 's1', seq: 4 })
check('regenerate succeeds', regenerated.ok === true, JSON.stringify(regenerated))
const regenMessage = sent[sent.length - 1]
check('regenerate resends the original prompt verbatim', regenMessage.content.length === 3, JSON.stringify(regenMessage.content))
check('regenerate keeps the image attachment', regenMessage.content.some((block) => block.type === 'image' && block.attachment.attachmentId === 'a1'), JSON.stringify(regenMessage.content))
check('regenerate keeps the file attachment', regenMessage.content.some((block) => block.type === 'file' && block.attachment.attachmentId === 'a2'), JSON.stringify(regenMessage.content))
check('regenerate keeps the original text', regenMessage.content.some((block) => block.type === 'text' && block.text === '看看这张图和笔记'), JSON.stringify(regenMessage.content))
const regenMarker = lastAppend()
check('regenerate shadows the prompt turn', regenMarker.data.message.id.startsWith('rewind:regenerate:') && JSON.stringify(regenMarker.surfaceOp) === JSON.stringify({ op: 'replace', startSeq: 3, endSeq: 4 }), JSON.stringify(regenMarker.surfaceOp))

/* -------------------------------------------------- legacy recall state --- */

host.resetSession()
host.session.append('system/message', { message: { id: 'rewind:recall:legacy', role: 'system', content: [] } }, {
  surfaceOp: { op: 'replace', startSeq: 3, endSeq: 4 }, sourceEventSeqs: [3, 4],
})
const legacyState = await call('state', { sessionId: 's1' })
check('legacy recall folds remain readable', legacyState.ok === true && legacyState.value.entries[0].kind === 'recall' && legacyState.value.entries[0].count === 2, JSON.stringify(legacyState))

/* --------------------------------------------------- edit edge cases --- */

host.resetSession()
const onlyAttachment = await call('edit', { sessionId: 's1', seq: 3, text: '', keep: ['a1', 'a2'] })
check('an edit may keep attachments without text', onlyAttachment.ok === true, JSON.stringify(onlyAttachment))
const attachmentOnlyContent = sent[sent.length - 1].content
check('text-less edit sends both attachments', attachmentOnlyContent.length === 2 && attachmentOnlyContent.every((block) => block.type !== 'text'), JSON.stringify(attachmentOnlyContent))

host.resetSession()
const emptied = await call('edit', { sessionId: 's1', seq: 3, text: '', keep: [] })
check('an empty edit is rejected', emptied.ok === false && emptied.error.code === 'empty-message', JSON.stringify(emptied))
check('a rejected edit sends nothing', sent.length === 0 && host.session.events.length === 6, sent.length + '/' + host.session.events.length)

const notUser = await call('edit', { sessionId: 's1', seq: 4, text: 'x' })
check('assistant messages cannot be edited', notUser.ok === false && notUser.error.code === 'not-a-user-message', JSON.stringify(notUser))

/* ------------------------------------------------------------ uploads --- */

const uploadedImage = await call('upload', {
  sessionId: 's1',
  kind: 'image',
  name: 'shot.png',
  mediaType: 'image/png',
  data: Buffer.from('abc').toString('base64'),
})
check('upload stores an image', uploadedImage.ok === true && uploadedImage.value.block.type === 'image' && uploadedImage.value.block.attachment.attachmentId === 'new-img', JSON.stringify(uploadedImage))
check('upload passes the media type through', savedImages.length === 1 && savedImages[0].mediaType === 'image/png' && savedImages[0].name === 'shot.png', JSON.stringify(savedImages[0] && savedImages[0].name))

const uploadedFile = await call('upload', {
  sessionId: 's1',
  kind: 'file',
  name: 'notes.md',
  data: Buffer.from('abc').toString('base64'),
})
check('upload stores a file', uploadedFile.ok === true && uploadedFile.value.block.type === 'file' && uploadedFile.value.block.attachment.attachmentId === 'new-file', JSON.stringify(uploadedFile))

const emptyUpload = await call('upload', { sessionId: 's1', kind: 'file', name: 'x', data: '' })
check('empty files are allowed and stored as zero bytes', emptyUpload.ok === true && emptyUpload.value.block.type === 'file' && savedFiles[savedFiles.length - 1].data.byteLength === 0, JSON.stringify(emptyUpload))

const emptyImage = await call('upload', { sessionId: 's1', kind: 'image', name: 'empty.png', data: '' })
check('empty images are rejected without saving', emptyImage.ok === false && emptyImage.error.code === 'invalid-attachment' && savedImages.length === 1, JSON.stringify(emptyImage))

const imageRead = await call('attachment', { sessionId: 's1', kind: 'image', attachment: { attachmentId: 'a1' } })
check('image bytes come back base64', imageRead.ok === true && imageRead.value.data === Buffer.from('png-bytes').toString('base64'), JSON.stringify(imageRead.value && imageRead.value.data))
check('image metadata comes from the readImage ref', imageRead.ok === true && imageRead.value.name === 'map.png' && imageRead.value.mediaType === 'image/png', JSON.stringify(imageRead.value))

const fileRead = await call('attachment', { sessionId: 's1', kind: 'file', attachment: { attachmentId: 'a2' } })
check('file bytes come back base64', fileRead.ok === true && fileRead.value.data === Buffer.from('file-bytes').toString('base64'), JSON.stringify(fileRead.value && fileRead.value.data))

/* ------------------------------------------------- admission is atomic --- */

const mutationCases = [
  { op: 'edit', body: { sessionId: 's1', seq: 3, text: 'replacement' } },
  { op: 'regenerate', body: { sessionId: 's1', seq: 4 } },
]

const preparationFailures = [
  { name: 'missing agent', code: 'agent-not-found', setup(h) { h.agent = undefined } },
  { name: 'agent without followup', code: 'agent-not-found', setup(h) { h.agent.followup = undefined } },
  { name: 'admission rejection', code: 'admission-denied', setup(h) { h.onAdmit = () => { throw fixtureError('admission-denied', 'attachment admission rejected') } } },
  { name: 'missing image', code: 'attachment-not-found', setup(h) { h.images.delete('a1') } },
  { name: 'missing file', code: 'attachment-not-found', setup(h) { h.files.delete('a2') } },
  { name: 'file stream failing after a chunk', code: 'file-read-failed', setup(h) { h.fileStreamError = fixtureError('file-read-failed', 'file disappeared while reading') } },
]

for (const { op, body } of mutationCases) {
  for (const scenario of preparationFailures) {
    const h = makeHost()
    scenario.setup(h)
    const before = mutationSnapshot(h)
    const reply = await h.call(op, body)
    check(op + ': ' + scenario.name + ' preserves history and followups', reply.ok === false && reply.error.code === scenario.code && mutationSnapshot(h) === before, JSON.stringify(reply))
  }

  const h = makeHost()
  h.images.get('a1').ref.name = 'canonical-map.png'
  const reply = await h.call(op, body)
  const admittedImage = h.admissions[0]?.find(part => part.type === 'image')
  const sentImage = h.sent[0]?.content.find(part => part.type === 'image')
  check(op + ': admission gets actual encoded image bytes and canonical ref metadata', reply.ok === true && admittedImage?.encodedBytes === h.images.get('a1').data.byteLength && admittedImage.attachment.name === 'canonical-map.png', JSON.stringify(h.admissions))
  check(op + ': admission metadata stays out of the queued message', reply.ok === true && sentImage?.attachment.name === 'canonical-map.png' && !Object.hasOwn(sentImage, 'encodedBytes'), JSON.stringify(h.sent))

  const limited = makeHost()
  limited.imageBudget = 12
  // Each image is nine bytes: only their aggregate exceeds the budget.
  const addedImage = { type: 'image', attachment: { attachmentId: 'a9' } }
  limited.session.eventAt(3).data.content.push(addedImage)
  const before = mutationSnapshot(limited)
  const rejected = await limited.call(op, body)
  check(op + ': aggregate image admission rejects before shadowing', rejected.ok === false && rejected.error.code === 'image-budget-exceeded' && mutationSnapshot(limited) === before, JSON.stringify({ reply: rejected, admission: limited.admissions }))
}


/* -------------------------------------- request and attachment limits --- */

{
  const h = makeHost()
  const reply = await h.callRaw('state', '{}', { headers: { 'content-length': String(32 * 1024 * 1024 + 1) } })
  check('declared request size is rejected before reading', reply.ok === false && reply.error.code === 'request-too-large', JSON.stringify(reply))
}

{
  const h = makeHost()
  const chunks = [Buffer.alloc(16 * 1024 * 1024), Buffer.alloc(16 * 1024 * 1024), Buffer.from([0])]
  const reply = await h.callRaw('state', '{}', { chunks })
  check('streamed request size is bounded without content-length', reply.ok === false && reply.error.code === 'request-too-large', JSON.stringify(reply))
}

{
  const h = makeHost()
  const tooLarge = Buffer.alloc(16 * 1024 * 1024 + 1)
  const reply = await h.call('upload', { sessionId: 's1', kind: 'image', name: 'too-large.png', data: tooLarge.toString('base64') })
  check('Base64 upload size is rejected before saving', reply.ok === false && reply.error.code === 'attachment-too-large' && h.savedImages.length === 0, JSON.stringify(reply))
}

{
  const h = makeHost()
  h.files.set('too-large', Buffer.alloc(16 * 1024 * 1024 + 1))
  const reply = await h.call('attachment', { sessionId: 's1', kind: 'file', attachment: { attachmentId: 'too-large', name: 'too-large.bin' } })
  check('streamed attachment size is rejected before encoding', reply.ok === false && reply.error.code === 'attachment-too-large', JSON.stringify(reply))
}

/* ------------------------------------------ followup transaction boundary --- */

for (const { op, body } of mutationCases) {
  const h = makeHost()
  h.onFollowup = async () => { throw fixtureError('provider-down', 'followup provider unavailable') }
  const before = mutationSnapshot(h)
  const reply = await h.call(op, body)
  check(op + ': followup failure leaves the old surface visible', reply.ok === false && reply.error.code === 'followup-failed' && mutationSnapshot(h) === before && h.session.events.filter(event => event.surfaceOp).length === 0, JSON.stringify(reply))
}

{
  const h = makeHost()
  const body = {
    sessionId: 's1',
    seq: 3,
    text: 'transactional file',
    add: [{ type: 'image', upload: { data: Buffer.from('new-image').toString('base64'), name: 'new.png', mediaType: 'image/png' } }],
  }
  h.onFollowup = async () => { throw fixtureError('provider-down', 'followup provider unavailable') }
  const before = mutationSnapshot(h)
  const reply = await h.call('edit', body)
  check('failed followup cleans materialized attachments', reply.ok === false && reply.error.code === 'followup-failed' && mutationSnapshot(h) === before && h.deletedImages.length === 1 && h.deletedFiles.length === 0, JSON.stringify({ reply, deletedImages: h.deletedImages }))
}

{
  const h = makeHost()
  const body = {
    sessionId: 's1',
    seq: 3,
    text: 'flush boundary',
    add: [{ type: 'image', upload: { data: Buffer.from('kept-image').toString('base64'), name: 'kept.png', mediaType: 'image/png' } }],
  }
  h.onFlush = async () => { throw fixtureError('disk-down', 'session persistence unavailable') }
  const reply = await h.call('edit', body)
  check('flush failure is reported after an accepted followup', reply.ok === false && reply.error.code === 'flush-failed' && h.sent.length === 1 && h.session.events.filter(event => event.surfaceOp).length === 1 && h.deletedImages.length === 0, JSON.stringify({ reply, deletedImages: h.deletedImages }))
}

{
  const h = makeHost()
  h.onAdmit = content => {
    const previous = h.agent
    h.agent = { ...previous, inbox: { get hasPending() { return h.pending.length > 0 } } }
    return content
  }
  const body = {
    sessionId: 's1',
    seq: 3,
    text: 'stale session',
    add: [{ type: 'image', upload: { data: Buffer.from('stale-image').toString('base64'), name: 'stale.png', mediaType: 'image/png' } }],
  }
  const before = mutationSnapshot(h)
  const reply = await h.call('edit', body)
  check('session change after preparation cleans materialized attachments', reply.ok === false && reply.error.code === 'session-changed' && mutationSnapshot(h) === before && h.deletedImages.length === 1, JSON.stringify({ reply, deletedImages: h.deletedImages }))
}

/* ------------------------------------------------------- idle failures --- */

const idleFailures = [
  { name: 'cancel throws', code: 'cancel-failed', setup(h) { h.onCancel = () => { throw fixtureError('cancel-failed', 'cancel failed') } } },
  { name: 'cancel promise rejects', code: 'cancel-failed', setup(h) { h.onCancel = () => Promise.reject(fixtureError('cancel-failed', 'cancel promise failed')) } },
  { name: 'whenIdle rejects', code: 'idle-rejected', setup(h) { h.onWhenIdle = () => Promise.reject(fixtureError('idle-rejected', 'idle barrier rejected')) } },
  { name: 'whenIdle returns while still running', code: 'session-busy', setup(h) { h.onCancel = () => {} } },
]

for (const { op, body } of mutationCases) {
  for (const scenario of idleFailures) {
    const h = makeHost()
    h.agent.status = 'running'
    scenario.setup(h)
    const before = mutationSnapshot(h)
    const reply = await h.call(op, body)
    check(op + ': ' + scenario.name + ' preserves history and followups', reply.ok === false && reply.error.code === scenario.code && mutationSnapshot(h) === before, JSON.stringify(reply))
    check(op + ': ' + scenario.name + ' cancels with keepInbox', h.cancellations.length === 1 && h.cancellations[0].reason.kind === 'user' && h.cancellations[0].options?.keepInbox === true, JSON.stringify(h.cancellations))
  }
}

// Exercise the real six-second deadline once, with a bounded outer deadline.
{
  const h = makeHost()
  h.agent.status = 'running'
  h.onWhenIdle = () => new Promise(() => {})
  const before = mutationSnapshot(h)
  const started = performance.now()
  const reply = await bounded(h.call('edit', mutationCases[0].body), 'idle timeout response', 10000)
  const elapsedMs = Math.round(performance.now() - started)
  check('whenIdle timeout preserves history and followups', reply.ok === false && reply.error.code === 'idle-timeout' && mutationSnapshot(h) === before, JSON.stringify({ reply, elapsedMs }))
  check('timed out cancellation keeps the inbox', h.cancellations.length === 1 && h.cancellations[0].options?.keepInbox === true, JSON.stringify(h.cancellations))
  h.onWhenIdle = null
  const retried = await h.call('edit', mutationCases[0].body)
  check('an idle timeout releases the session mutation lock', retried.ok === true && h.sent.length === 1, JSON.stringify(retried))
}

{
  const h = makeHost()
  h.agent.status = 'running'
  h.onCancel = () => new Promise(() => {})
  const before = mutationSnapshot(h)
  const started = performance.now()
  const reply = await bounded(h.call('edit', mutationCases[0].body), 'cancel timeout response', 10000)
  const elapsedMs = Math.round(performance.now() - started)
  check('hanging cancellation has a bounded failure', reply.ok === false && reply.error.code === 'cancel-timeout' && mutationSnapshot(h) === before && h.idleCalls === 0 && elapsedMs >= 5500 && elapsedMs < 9500, JSON.stringify({ reply, elapsedMs }))
}

/* -------------------------------------------- maintenance and concurrency --- */

for (const { op, body } of mutationCases) {
  const h = makeHost()
  const entered = deferred()
  const idle = deferred()
  h.onWhenIdle = () => { entered.resolve(); return idle.promise }
  const before = mutationSnapshot(h)
  let settled = false
  const first = h.call(op, body).then(reply => { settled = true; return reply })
  try {
    await bounded(entered.promise, op + ' maintenance barrier')
    check(op + ': idle-status maintenance waits before touching history', h.agent.status === 'idle' && !settled && h.idleCalls === 1 && h.cancellations.length === 0 && mutationSnapshot(h) === before, mutationSnapshot(h))
    const other = mutationCases.find(item => item.op !== op)
    const second = await bounded(h.call(other.op, other.body), 'concurrent request')
    check(op + ': another operation in the same session is rejected', second.ok === false && second.error.code === 'operation-in-progress' && mutationSnapshot(h) === before, JSON.stringify(second))
  } finally {
    idle.resolve()
  }
  const reply = await bounded(first, op + ' after maintenance')
  check(op + ': maintenance completion permits exactly one replacement', reply.ok === true && h.sent.length === 1 && h.session.events.filter(event => event.surfaceOp).length === 1, JSON.stringify(reply))
  h.resetSession()
  h.onWhenIdle = null
  const retried = await h.call(op, body)
  check(op + ': completed operation releases the session mutation lock', retried.ok === true, JSON.stringify(retried))
}

/* ----------------------------------------------------- inbox protection --- */

for (const { op, body } of mutationCases) {
  const h = makeHost()
  const queued = { id: 'queued-human-input', role: 'user', content: [{ type: 'text', text: 'do not discard' }] }
  h.pending.push(queued)
  h.agent.status = 'running'
  const before = mutationSnapshot(h)
  const reply = await h.call(op, body)
  check(op + ': pending inbox is rejected without canceling or discarding it', reply.ok === false && reply.error.code === 'pending-input' && mutationSnapshot(h) === before && h.cancellations.length === 0 && h.pending.length === 1 && h.pending[0] === queued, JSON.stringify(reply))

  const late = makeHost()
  late.agent.status = 'running'
  late.onWhenIdle = async () => { late.pending.push(queued) }
  const lateBefore = mutationSnapshot(late)
  const lateReply = await late.call(op, body)
  check(op + ': input arriving during cancellation prevents replacement', lateReply.ok === false && lateReply.error.code === 'pending-input' && mutationSnapshot(late) === lateBefore && late.pending[0] === queued && late.cancellations[0]?.options?.keepInbox === true, JSON.stringify(lateReply))
}

/* ---------------------------------------------------- synchronous enqueue --- */

for (const { op, body } of mutationCases) {
  const h = makeHost()
  const flushing = deferred()
  const flush = deferred()
  let queuedAtFlush = false
  let queuedBeforeYield = false
  const append = h.session.append.bind(h.session)
  h.session.append = (type, data, options) => {
    const event = append(type, data, options)
    if (options?.surfaceOp) {
      queueMicrotask(() => { queuedBeforeYield = h.pending.length === 1 && h.pending[0] === h.sent[0] })
    }
    return event
  }
  h.onFlush = session => {
    queuedAtFlush = session.surface.nodes.length === 2 && h.pending.length === 1 && h.pending[0] === h.sent[0]
    flushing.resolve()
    return flush.promise
  }
  let settled = false
  const request = h.call(op, body).then(reply => { settled = true; return reply })
  try {
    await bounded(flushing.promise, op + ' flush barrier')
    check(op + ': replacement is queued synchronously before flush can await', queuedAtFlush && queuedBeforeYield && !settled, JSON.stringify({ queuedAtFlush, queuedBeforeYield, settled }))
  } finally {
    flush.resolve()
  }
  const reply = await bounded(request, op + ' after flush')
  check(op + ': releasing flush completes without duplicating the replacement', reply.ok === true && h.sent.length === 1 && h.flushed.length === 1, JSON.stringify(reply))
}

/* ----------------------------------------------------- target provenance --- */

for (const seq of [0, 3]) {
  const h = makeHost()
  const before = mutationSnapshot(h)
  const reply = await h.call('regenerate', { sessionId: 's1', seq })
  check('regenerate rejects non-assistant target ' + seq + ' without mutation', reply.ok === false && reply.error.code === 'not-an-assistant-message' && mutationSnapshot(h) === before, JSON.stringify(reply))
}

for (const { op, body } of mutationCases) {
  for (const kind of ['tool', 'goal']) {
    const h = makeHost()
    h.session.eventAt(3).data.source = { kind, rpcId: 'synthetic-user' }
    const before = mutationSnapshot(h)
    const reply = await h.call(op, body)
    const expected = op === 'edit' ? 'not-a-user-message' : 'no-prompt'
    check(op + ': a ' + kind + ' user-role message cannot stand in for human input', reply.ok === false && reply.error.code === expected && mutationSnapshot(h) === before, JSON.stringify(reply))
  }
}

/* ----------------------------------------------------- sequence validation --- */

for (const { op, body } of mutationCases) {
  const h = makeHost()
  h.agent.status = 'running'
  const before = mutationSnapshot(h)
  const replies = []
  for (const seq of [null, false, '3', -1, 3.5, Number.MAX_SAFE_INTEGER + 1]) {
    replies.push(await h.call(op, { ...body, seq }))
  }
  check(op + ': invalid sequences are rejected without coercion or mutation', replies.every(reply => reply.ok === false && reply.error.code === 'invalid-seq') && mutationSnapshot(h) === before && h.cancellations.length === 0, JSON.stringify(replies))
}

/* ----------------------------------------------------- request validation --- */

for (const invalid of [null, [], true, 42, 's1']) {
  const h = makeHost()
  const before = mutationSnapshot(h)
  const reply = await h.call('edit', invalid)
  check('non-object JSON is rejected: ' + JSON.stringify(invalid), reply.ok === false && reply.error.code === 'invalid-body' && mutationSnapshot(h) === before, JSON.stringify(reply))
}

{
  const h = makeHost()
  const before = mutationSnapshot(h)
  const reply = await h.callRaw('regenerate', '{"sessionId":')
  check('malformed JSON is rejected without mutation', reply.ok === false && reply.error.code === 'invalid-body' && mutationSnapshot(h) === before, JSON.stringify(reply))
}

for (const kind of ['image', 'file']) {
  const h = makeHost()
  const replies = []
  // Node's permissive decoder accepts these; the upload boundary must not.
  for (const data of ['YQ==junk', 'YQ==!', 'YQ==\n', 'YR==']) {
    replies.push(await h.call('upload', { sessionId: 's1', kind, name: 'invalid', data }))
  }
  check(kind + ' upload rejects trailing garbage and noncanonical Base64 before saving', replies.every(reply => reply.ok === false && reply.error.code === 'invalid-attachment') && h.savedImages.length === 0 && h.savedFiles.length === 0, JSON.stringify(replies))
}

/* -------------------------------------------------------- original text --- */

{
  const h = makeHost()
  const text = '  \t\n  preserve indentation and surrounding whitespace  \n\t '
  const reply = await h.call('edit', { sessionId: 's1', seq: 3, text, keep: [] })
  check('edit preserves leading and trailing text whitespace', reply.ok === true && h.sent[0]?.content[0]?.text === text, JSON.stringify(h.sent))
}

{
  const h = makeHost()
  const text = [
    { type: 'text', text: '  first line\n\t' },
    { type: 'text', text: ' \t\n ' },
    { type: 'text', text: '\n  last line  ' },
  ]
  h.session.eventAt(3).data.content = text
  const reply = await h.call('regenerate', { sessionId: 's1', seq: 4 })
  check('regenerate preserves text blocks including whitespace-only blocks', reply.ok === true && JSON.stringify(h.sent[0]?.content) === JSON.stringify(text), JSON.stringify(h.sent))
}

/* -------------------------------------------------------------- report --- */

const failed = results.filter((item) => !item.ok)
for (const item of results) console.log((item.ok ? 'ok   ' : 'FAIL ') + item.name + (item.ok ? '' : '  <<< ' + item.detail))
console.log('')
console.log('HOST ' + (failed.length === 0 ? 'OK' : 'FAILED') + ' (' + results.length + ' checks, ' + failed.length + ' failed)')
process.exit(failed.length === 0 ? 0 : 1)