/**
 * dsh-rewind — host half.
 *
 * Applies message editing, recall (withdrawal) and regeneration to a live DSH
 * session by appending surface replacement events and, where a new turn is
 * needed, handing an already-admitted user message to the session agent.
 *
 * Design notes
 * ------------
 * - Only official session event types are ever written. A withdrawal / edit is
 *   a `system/message` event with empty content carrying a
 *   `surfaceOp: { op: 'replace', startSeq, endSeq }`. Empty content makes
 *   `deriveEventMessage` return null, so the replacement contributes no
 *   provider message at all: the model simply never sees the shadowed range.
 * - The marker is self-describing: `data.message.id` starts with
 *   `rewind:<kind>:` and `sourceEventSeqs` lists exactly the shadowed
 *   surface nodes, so the client can rebuild the fold state from the log alone.
 *   Nothing is duplicated into a side store, which keeps forks and restores
 *   honest.
 * - Attachments are never re-encoded. Re-sent messages carry the original
 *   `{type:'image', attachment}` / `{type:'file', attachment}` references,
 *   which `admitPromptContent` passes through untouched.
 */

import { randomUUID } from 'node:crypto'

export const name = 'rewind'
export const inject = ['connection']

const ROUTE_PREFIX = '/api/dsh-rewind'
const MARKER_PREFIX = 'rewind:'
const IDLE_TIMEOUT_MS = 6000

/* ------------------------------------------------------------------ */
/* plumbing                                                            */
/* ------------------------------------------------------------------ */

function rewindError(code, message) {
  const error = new Error(message)
  error.code = code
  return error
}

function jsonResponse(body) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  })
}

function succeed(value) {
  return jsonResponse({ ok: true, value })
}

function failWith(error) {
  if (error && typeof error.code === 'string' && typeof error.message === 'string') {
    return jsonResponse({ ok: false, error: { code: error.code, message: error.message } })
  }
  return jsonResponse({
    ok: false,
    error: { code: 'rewind-failed', message: error instanceof Error ? error.message : String(error) },
  })
}

async function readJsonBody(request) {
  const text = typeof request.text === 'function' ? await request.text() : ''
  if (!text || text.trim() === '') return {}
  try {
    return JSON.parse(text)
  } catch {
    throw rewindError('invalid-body', 'request body is not JSON')
  }
}

function delay(ms) {
  return new Promise(resolve => {
    const timer = setTimeout(resolve, ms)
    if (typeof timer === 'object' && timer !== null && typeof timer.unref === 'function') timer.unref()
  })
}

/* ------------------------------------------------------------------ */
/* session access                                                      */
/* ------------------------------------------------------------------ */

function eventsOf(session) {
  try {
    const events = typeof session.snapshotEvents === 'function' ? session.snapshotEvents() : undefined
    if (Array.isArray(events)) return events
  } catch {
    /* fall through to the legacy accessor */
  }
  const legacy = session && session.events
  return Array.isArray(legacy) ? legacy : []
}

function requireSession(ctx, sessionId) {
  if (typeof sessionId !== 'string' || sessionId === '') {
    throw rewindError('invalid-session', '缺少会话标识')
  }
  const sessions = ctx.get('sessions')
  const session = sessions && typeof sessions.get === 'function' ? sessions.get(sessionId) : undefined
  if (!session) throw rewindError('session-not-found', '该会话尚未加载，请先在 DSH 里打开它')
  return session
}

function requireAgent(ctx, sessionId) {
  const agents = ctx.get('agents')
  const agent = agents && typeof agents.get === 'function' ? agents.get(sessionId) : undefined
  if (!agent || typeof agent.followup !== 'function') {
    throw rewindError('agent-not-found', '该会话当前没有可用的代理，无法发起新一轮')
  }
  return agent
}

function surfaceNodes(session) {
  const nodes = session && session.surface ? session.surface.nodes : undefined
  if (!Array.isArray(nodes)) throw rewindError('surface-unavailable', '无法读取会话上下文')
  return nodes
}

function eventAt(session, seq) {
  try {
    return typeof session.eventAt === 'function' ? session.eventAt(seq) : undefined
  } catch {
    return undefined
  }
}

function turnAt(events, seq) {
  let turn = 0
  for (const event of events) {
    if (event.seq > seq) break
    if (event.type === 'turn/start') turn = event.data.turn
  }
  return turn
}

function lastTurnStep(events) {
  let turn = 0
  let step = 0
  for (const event of events) {
    if (event.type === 'turn/start') {
      turn = event.data.turn
      step = 0
    } else if (event.type === 'step/start') {
      step = event.data.step
    }
  }
  return { turn, step }
}

/* ------------------------------------------------------------------ */
/* fold state                                                          */
/* ------------------------------------------------------------------ */

function isRewindMarker(event) {
  if (!event || event.type !== 'system/message') return false
  if (!event.surfaceOp || event.surfaceOp === 'append') return false
  const id = event.data && event.data.message ? event.data.message.id : undefined
  return typeof id === 'string' && id.startsWith(MARKER_PREFIX)
}

function markerKind(event) {
  const id = String(event && event.data && event.data.message ? event.data.message.id : '')
  const rest = id.slice(MARKER_PREFIX.length)
  const colon = rest.indexOf(':')
  return colon < 0 ? rest : rest.slice(0, colon)
}

function foldState(session) {
  const events = eventsOf(session)
  const bySeq = new Map()
  for (const event of events) bySeq.set(event.seq, event)

  const entries = []
  for (const event of events) {
    if (!isRewindMarker(event)) continue
    const range = event.surfaceOp
    const startSeq = typeof range.startSeq === 'number' ? range.startSeq : range.start
    if (typeof startSeq !== 'number') continue
    const endSeq = typeof range.endSeq === 'number' ? range.endSeq : range.end
    const shadowed = Array.isArray(event.sourceEventSeqs) ? event.sourceEventSeqs.slice() : []
    let count = 0
    for (const seq of shadowed) {
      const target = bySeq.get(seq)
      if (target && (target.type === 'user/message' || target.type === 'assistant/message')) count += 1
    }
    entries.push({
      markerSeq: event.seq,
      kind: markerKind(event),
      startSeq,
      endSeq: typeof endSeq === 'number' ? endSeq : startSeq,
      turn: turnAt(events, startSeq),
      shadowed,
      count,
      time: typeof event.time === 'number' ? event.time : null,
    })
  }
  return { entries }
}

/* ------------------------------------------------------------------ */
/* writes                                                              */
/* ------------------------------------------------------------------ */

function shadowSpan(session, startSeq) {
  const nodes = surfaceNodes(session)
  const index = nodes.indexOf(startSeq)
  if (index < 0) throw rewindError('seq-not-in-surface', '这条消息已经不在模型上下文中了')
  if (index === 0) throw rewindError('protected-span', '不能遮蔽会话的系统提示')
  const shadowed = nodes.slice(index)
  return { startSeq: shadowed[0], endSeq: shadowed[shadowed.length - 1], shadowed }
}

function markerId(kind) {
  return MARKER_PREFIX + kind + ':' + randomUUID()
}

function writeShadow(session, kind, span) {
  const events = eventsOf(session)
  const position = lastTurnStep(events)
  session.append(
    'system/message',
    {
      turn: position.turn,
      step: position.step,
      message: {
        id: markerId(kind),
        role: 'system',
        content: [],
        source: { kind: 'system-prompt' },
      },
    },
    {
      surfaceOp: { op: 'replace', startSeq: span.startSeq, endSeq: span.endSeq },
      sourceEventSeqs: span.shadowed,
    },
  )
}

async function flushSession(ctx, session) {
  const sessions = ctx.get('sessions')
  if (sessions && typeof sessions.flush === 'function') {
    try {
      await sessions.flush(session)
    } catch {
      /* flush is best effort; the append already landed in memory */
    }
  }
}

async function ensureIdle(ctx, sessionId) {
  const agents = ctx.get('agents')
  const agent = agents && typeof agents.get === 'function' ? agents.get(sessionId) : undefined
  if (!agent) return
  try {
    if (agent.status !== 'running') return
    if (typeof agent.cancel === 'function') agent.cancel({ kind: 'user' })
    if (typeof agent.whenIdle === 'function') {
      await Promise.race([agent.whenIdle(), delay(IDLE_TIMEOUT_MS)])
    }
  } catch {
    /* a still-running turn costs us ordering, not correctness */
  }
}

const MESSAGE_BLOCK_TYPES = new Set(['text', 'image', 'file'])

function normaliseBlocks(blocks) {
  if (!Array.isArray(blocks)) return []
  const kept = []
  for (const block of blocks) {
    if (!block || typeof block !== 'object') continue
    if (!MESSAGE_BLOCK_TYPES.has(block.type)) continue
    if (block.type === 'text') {
      if (typeof block.text === 'string' && block.text !== '') kept.push({ type: 'text', text: block.text })
      continue
    }
    if (block.attachment && typeof block.attachment === 'object') {
      kept.push({ type: block.type, attachment: block.attachment })
    }
  }
  return kept
}

function userBlocksOf(session, seq) {
  const event = eventAt(session, seq)
  if (!event || event.type !== 'user/message') return null
  return normaliseBlocks(event.data ? event.data.content : undefined)
}

function textOfBlocks(blocks) {
  const parts = []
  for (const block of blocks) {
    if (block.type === 'text') parts.push(block.text)
  }
  return parts.join('\n')
}

function attachmentIdOf(block) {
  if (!block || !block.attachment) return undefined
  return typeof block.attachment.attachmentId === 'string' ? block.attachment.attachmentId : undefined
}

async function admit(ctx, content) {
  const attachments = ctx.get('attachments')
  if (attachments && typeof attachments.admitPromptContent === 'function') {
    return await attachments.admitPromptContent(content)
  }
  return content
}

async function sendUserMessage(ctx, sessionId, content) {
  const agent = requireAgent(ctx, sessionId)
  const admitted = await admit(ctx, content)
  const message = {
    id: randomUUID(),
    role: 'user',
    content: admitted,
    source: { kind: 'user', rpcId: randomUUID() },
  }
  agent.followup(message)
  return { blocks: admitted.length }
}

/* ------------------------------------------------------------------ */
/* operations                                                          */
/* ------------------------------------------------------------------ */

async function opEdit(ctx, body) {
  const sessionId = body.sessionId
  const session = requireSession(ctx, sessionId)
  const seq = Number(body.seq)
  if (!Number.isFinite(seq)) throw rewindError('invalid-seq', '缺少消息位置')
  const text = typeof body.text === 'string' ? body.text.trim() : ''
  const original = userBlocksOf(session, seq)
  if (original === null) throw rewindError('not-a-user-message', '只有用户消息可以编辑')

  const keepIds = Array.isArray(body.keep) ? body.keep.filter(id => typeof id === 'string') : null
  const content = []
  for (const block of original) {
    if (block.type === 'text') continue
    const id = attachmentIdOf(block)
    if (keepIds !== null && (id === undefined || !keepIds.includes(id))) continue
    content.push(block)
  }
  if (Array.isArray(body.add)) {
    for (const block of normaliseBlocks(body.add)) content.push(block)
  }
  if (text !== '') content.unshift({ type: 'text', text })
  if (content.length === 0) throw rewindError('empty-message', '消息不能为空')

  await ensureIdle(ctx, sessionId)
  const span = shadowSpan(session, seq)
  writeShadow(session, 'edit', span)
  await flushSession(ctx, session)
  const sent = await sendUserMessage(ctx, sessionId, content)
  return { shadowed: span.shadowed.length, blocks: sent.blocks }
}

async function opRecall(ctx, body) {
  const sessionId = body.sessionId
  const session = requireSession(ctx, sessionId)
  const seq = Number(body.seq)
  if (!Number.isFinite(seq)) throw rewindError('invalid-seq', '缺少消息位置')
  await ensureIdle(ctx, sessionId)
  const span = shadowSpan(session, seq)
  writeShadow(session, 'recall', span)
  await flushSession(ctx, session)
  return { shadowed: span.shadowed.length }
}

async function opRegenerate(ctx, body) {
  const sessionId = body.sessionId
  const session = requireSession(ctx, sessionId)
  const seq = Number(body.seq)
  if (!Number.isFinite(seq)) throw rewindError('invalid-seq', '缺少消息位置')

  const nodes = surfaceNodes(session)
  let promptSeq
  const index = nodes.indexOf(seq)
  if (index >= 0) {
    for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
      const event = eventAt(session, nodes[cursor])
      if (event && event.type === 'user/message' && event.data && event.data.source && event.data.source.kind === 'user') {
        promptSeq = nodes[cursor]
        break
      }
    }
  }
  if (promptSeq === undefined) throw rewindError('no-prompt', '找不到这条回复对应的用户消息')

  const content = userBlocksOf(session, promptSeq) || []
  if (content.length === 0) throw rewindError('no-prompt', '原始提问已经不在上下文中')

  await ensureIdle(ctx, sessionId)
  const span = shadowSpan(session, promptSeq)
  writeShadow(session, 'regenerate', span)
  await flushSession(ctx, session)
  const sent = await sendUserMessage(ctx, sessionId, content)
  return { shadowed: span.shadowed.length, blocks: sent.blocks }
}

/* ------------------------------------------------------------------ */
/* attachment transit                                                  */
/* ------------------------------------------------------------------ */

async function opAttachment(ctx, body) {
  requireSession(ctx, body.sessionId)
  const attachments = ctx.get('attachments')
  if (!attachments) throw rewindError('attachments-unavailable', '附件服务不可用')
  const ref = body.attachment
  if (!ref || typeof ref !== 'object' || typeof ref.attachmentId !== 'string') {
    throw rewindError('invalid-attachment', '缺少附件标识')
  }

  if (body.kind === 'image') {
    if (typeof attachments.readImage !== 'function') throw rewindError('unsupported', '当前附件存储不支持读取图片')
    const stored = await attachments.readImage(ref)
    const meta = (stored && stored.attachment) || {}
    return {
      name: meta.name || ref.name || 'image',
      mediaType: meta.mediaType || ref.mediaType || 'image/png',
      data: Buffer.from(stored.data).toString('base64'),
    }
  }

  if (typeof attachments.readFileStream !== 'function') throw rewindError('unsupported', '当前附件存储不支持读取文件')
  const chunks = []
  for await (const chunk of attachments.readFileStream(ref)) chunks.push(Buffer.from(chunk))
  return {
    name: typeof ref.name === 'string' ? ref.name : 'file',
    mediaType: 'application/octet-stream',
    data: Buffer.concat(chunks).toString('base64'),
  }
}

async function opUpload(ctx, body) {
  requireSession(ctx, body.sessionId)
  const attachments = ctx.get('attachments')
  if (!attachments) throw rewindError('attachments-unavailable', '附件服务不可用')
  const data = typeof body.data === 'string' ? Buffer.from(body.data, 'base64') : null
  if (!data || data.byteLength === 0) throw rewindError('invalid-attachment', '附件内容为空')
  const label = typeof body.name === 'string' && body.name !== '' ? body.name : 'attachment'

  if (body.kind === 'image') {
    const mediaType = typeof body.mediaType === 'string' ? body.mediaType : 'image/png'
    const ref = await attachments.saveImage({ data: new Uint8Array(data), mediaType, name: label })
    return { block: { type: 'image', attachment: ref } }
  }
  const ref = await attachments.saveFile({ data: new Uint8Array(data), name: label })
  return { block: { type: 'file', attachment: ref } }
}

/* ------------------------------------------------------------------ */
/* plugin                                                              */
/* ------------------------------------------------------------------ */

export function apply(ctx) {
  const log = (...args) => {
    try {
      const logger = typeof ctx.logger === 'function' ? ctx.logger('rewind') : undefined
      if (logger && typeof logger.info === 'function') logger.info(...args)
      else console.info('[dsh-rewind]', ...args)
    } catch {
      /* logging must never break an operation */
    }
  }

  const route = (path, handler) => {
    ctx.effect(
      () =>
        ctx.connection.fetch.register({
          path: ROUTE_PREFIX + '/' + path,
          methods: ['POST'],
          requestBody: 'buffered',
          fetch: async request => {
            try {
              return succeed(await handler(await readJsonBody(request)))
            } catch (error) {
              log(path, 'failed:', error && error.message)
              return failWith(error)
            }
          },
        }),
      'dsh-rewind: ' + path,
    )
  }

  route('state', async body => ({ entries: foldState(requireSession(ctx, body.sessionId)).entries }))
  route('edit', body => opEdit(ctx, body))
  route('recall', body => opRecall(ctx, body))
  route('regenerate', body => opRegenerate(ctx, body))
  route('attachment', body => opAttachment(ctx, body))
  route('upload', body => opUpload(ctx, body))

  log('host ready')
}
