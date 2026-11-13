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

const sent = []
const savedImages = []
const savedFiles = []
const flushed = []

let current = makeSession()
const agent = {
  status: 'idle',
  followup(message) {
    sent.push(message)
  },
  cancel() {},
  async whenIdle() {},
}
const attachments = {
  async admitPromptContent(content) {
    return content
  },
  async readImage(ref) {
    return { attachment: { name: 'map.png', mediaType: 'image/png' }, data: Buffer.from('png-bytes') }
  },
  async *readFileStream(ref) {
    yield Buffer.from('file-bytes')
  },
  async saveImage(input) {
    savedImages.push(input)
    return { attachmentId: 'new-img', mediaType: input.mediaType, name: input.name }
  },
  async saveFile(input) {
    savedFiles.push(input)
    return { attachmentId: 'new-file', mediaType: 'text/plain', name: input.name }
  },
}

const routes = {}
const ctx = {
  effect(register) {
    const dispose = register()
    return typeof dispose === 'function' ? dispose : () => {}
  },
  get(name) {
    if (name === 'sessions') {
      return {
        get(id) {
          return id === 's1' ? current : undefined
        },
        async flush(target) {
          flushed.push(target)
        },
      }
    }
    if (name === 'agents') {
      return {
        get(id) {
          return id === 's1' ? agent : undefined
        },
      }
    }
    if (name === 'attachments') return attachments
    return undefined
  },
  connection: {
    fetch: {
      register(options) {
        routes[options.path.slice('/api/dsh-rewind/'.length)] = options.fetch
        return () => {}
      },
    },
  },
  logger() {
    return { info() {}, warn() {} }
  },
}

apply(ctx)

const call = async (op, body) => {
  const handler = routes[op]
  if (!handler) throw new Error('route not registered: ' + op)
  const response = await handler({
    async text() {
      return JSON.stringify(body === undefined ? {} : body)
    },
  })
  return response.json()
}

const lastAppend = () => current.events[current.events.length - 1]

/* ---------------------------------------------------------------- state --- */

check('all six routes registered', Object.keys(routes).sort().join(',') === 'attachment,edit,recall,regenerate,state,upload', Object.keys(routes).join(','))
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

const again = await call('recall', { sessionId: 's1', seq: 3 })
check('a shadowed message cannot be edited twice', again.ok === false && again.error.code === 'seq-not-in-surface', JSON.stringify(again))

/* ---------------------------------------------------------- regenerate --- */

sent.length = 0
current = makeSession()
const regenerated = await call('regenerate', { sessionId: 's1', seq: 4 })
check('regenerate succeeds', regenerated.ok === true, JSON.stringify(regenerated))
const regenMessage = sent[sent.length - 1]
check('regenerate resends the original prompt verbatim', regenMessage.content.length === 3, JSON.stringify(regenMessage.content))
check('regenerate keeps the image attachment', regenMessage.content.some((block) => block.type === 'image' && block.attachment.attachmentId === 'a1'), JSON.stringify(regenMessage.content))
check('regenerate keeps the file attachment', regenMessage.content.some((block) => block.type === 'file' && block.attachment.attachmentId === 'a2'), JSON.stringify(regenMessage.content))
check('regenerate keeps the original text', regenMessage.content.some((block) => block.type === 'text' && block.text === '看看这张图和笔记'), JSON.stringify(regenMessage.content))
const regenMarker = lastAppend()
check('regenerate shadows the prompt turn', regenMarker.data.message.id.startsWith('rewind:regenerate:') && JSON.stringify(regenMarker.surfaceOp) === JSON.stringify({ op: 'replace', startSeq: 3, endSeq: 4 }), JSON.stringify(regenMarker.surfaceOp))

/* -------------------------------------------------------------- recall --- */

sent.length = 0
current = makeSession()
const recalled = await call('recall', { sessionId: 's1', seq: 3 })
check('recall succeeds', recalled.ok === true && recalled.value.shadowed === 2, JSON.stringify(recalled))
check('recall sends nothing to the model', sent.length === 0, sent.length)
const recallMarker = lastAppend()
check('recall marker is empty too', recallMarker.data.message.content.length === 0 && recallMarker.data.message.id.startsWith('rewind:recall:'), recallMarker.data.message.id)

current = makeSession()
const protectedSpan = await call('recall', { sessionId: 's1', seq: 0 })
check('the system prompt cannot be shadowed', protectedSpan.ok === false && protectedSpan.error.code === 'protected-span', JSON.stringify(protectedSpan))

/* --------------------------------------------------- edit edge cases --- */

sent.length = 0
current = makeSession()
const onlyAttachment = await call('edit', { sessionId: 's1', seq: 3, text: '', keep: ['a1', 'a2'] })
check('an edit may keep attachments without text', onlyAttachment.ok === true, JSON.stringify(onlyAttachment))
const attachmentOnlyContent = sent[sent.length - 1].content
check('text-less edit sends both attachments', attachmentOnlyContent.length === 2 && attachmentOnlyContent.every((block) => block.type !== 'text'), JSON.stringify(attachmentOnlyContent))

current = makeSession()
sent.length = 0
const emptied = await call('edit', { sessionId: 's1', seq: 3, text: '', keep: [] })
check('an empty edit is rejected', emptied.ok === false && emptied.error.code === 'empty-message', JSON.stringify(emptied))
check('a rejected edit sends nothing', sent.length === 0 && current.events.length === 6, sent.length + '/' + current.events.length)

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
check('empty uploads are rejected', emptyUpload.ok === false && emptyUpload.error.code === 'invalid-attachment', JSON.stringify(emptyUpload))

const imageRead = await call('attachment', { sessionId: 's1', kind: 'image', attachment: { attachmentId: 'a1' } })
check('image bytes come back base64', imageRead.ok === true && imageRead.value.data === Buffer.from('png-bytes').toString('base64'), JSON.stringify(imageRead.value && imageRead.value.data))

const fileRead = await call('attachment', { sessionId: 's1', kind: 'file', attachment: { attachmentId: 'a2' } })
check('file bytes come back base64', fileRead.ok === true && fileRead.value.data === Buffer.from('file-bytes').toString('base64'), JSON.stringify(fileRead.value && fileRead.value.data))

/* -------------------------------------------------------------- report --- */

const failed = results.filter((item) => !item.ok)
for (const item of results) console.log((item.ok ? 'ok   ' : 'FAIL ') + item.name + (item.ok ? '' : '  <<< ' + item.detail))
console.log('')
console.log('HOST ' + (failed.length === 0 ? 'OK' : 'FAILED') + ' (' + results.length + ' checks, ' + failed.length + ' failed)')
process.exit(failed.length === 0 ? 0 : 1)