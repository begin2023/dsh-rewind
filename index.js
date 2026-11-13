/**
 * dsh-rewind — host half.
 *
 * Applies message editing and regeneration to a live DSH session by appending
 * surface replacement events and handing an already-admitted user message to
 * the session agent.
 *
 * Design notes
 * ------------
 * - Only official session event types are ever written. Each replacement is
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
const MAX_REQUEST_BYTES = 32 * 1024 * 1024
const MAX_ATTACHMENT_BYTES = 16 * 1024 * 1024
const MAX_BASE64_CHARS = Math.ceil(MAX_ATTACHMENT_BYTES / 3) * 4

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

function declaredRequestBytes(request) {
  const headers = request && request.headers
  if (!headers || typeof headers.get !== 'function') return null
  const value = Number(headers.get('content-length'))
  return Number.isSafeInteger(value) && value >= 0 ? value : null
}

async function readRequestText(request) {
  if (request && request.body && typeof request.body.getReader === 'function') {
    const reader = request.body.getReader()
    const chunks = []
    let total = 0
    try {
      while (true) {
        const part = await reader.read()
        if (!part || part.done) break
        let chunk
        try {
          if (part.value instanceof ArrayBuffer) chunk = Buffer.from(new Uint8Array(part.value))
          else chunk = Buffer.from(part.value)
        } catch {
          throw rewindError('invalid-body', 'request body is not readable')
        }
        total += chunk.byteLength
        if (total > MAX_REQUEST_BYTES) throw rewindError('request-too-large', '请求体超过 32 MiB 限制')
        chunks.push(chunk)
      }
      return Buffer.concat(chunks, total).toString('utf8')
    } finally {
      if (typeof reader.releaseLock === 'function') reader.releaseLock()
    }
  }
  return typeof request?.text === 'function' ? await request.text() : ''
}

async function readJsonBody(request) {
  const declaredBytes = declaredRequestBytes(request)
  if (declaredBytes !== null && declaredBytes > MAX_REQUEST_BYTES) {
    throw rewindError('request-too-large', '请求体超过 32 MiB 限制')
  }
  const text = await readRequestText(request)
  if (Buffer.byteLength(text, 'utf8') > MAX_REQUEST_BYTES) {
    throw rewindError('request-too-large', '请求体超过 32 MiB 限制')
  }
  if (!text || text.trim() === '') return {}
  let body
  try {
    body = JSON.parse(text)
  } catch {
    throw rewindError('invalid-body', 'request body is not JSON')
  }
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw rewindError('invalid-body', 'request body must be a JSON object')
  }
  return body
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
    } catch (error) {
      // The append is already in memory, so report the persistence boundary
      // explicitly instead of claiming that the operation completed.
      throw rewindError('flush-failed', error instanceof Error ? error.message : String(error))
    }
  }
}

function assertNoPendingInput(agent) {
  if (agent.inbox && agent.inbox.hasPending) {
    throw rewindError('pending-input', '该会话还有排队中的输入，请先处理后再编辑或重新生成')
  }
}

async function ensureIdle(agent) {
  assertNoPendingInput(agent)
  if (agent.status === 'running') {
    if (typeof agent.cancel !== 'function') throw rewindError('session-busy', '无法停止当前生成')
    // Never discard a queued message if one arrives during cancellation. A broken
    // cancellation must also have a bound; otherwise the route can hang forever.
    let cancelTimer
    try {
      const cancellation = agent.cancel({ kind: 'user' }, { keepInbox: true })
      await Promise.race([
        Promise.resolve(cancellation),
        new Promise((_, reject) => {
          cancelTimer = setTimeout(() => reject(rewindError('cancel-timeout', '停止生成超时，未修改会话历史')), IDLE_TIMEOUT_MS)
        }),
      ])
    } catch (error) {
      if (error && error.code === 'cancel-timeout') throw error
      throw rewindError('cancel-failed', error instanceof Error ? error.message : String(error))
    } finally {
      clearTimeout(cancelTimer)
    }
  }
  if (typeof agent.whenIdle !== 'function') throw rewindError('idle-unavailable', '无法确认会话已停止')
  let timer
  try {
    // Maintenance can report idle while it still owns the session: always drain it.
    await Promise.race([
      agent.whenIdle(),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(rewindError('idle-timeout', '停止生成超时，未修改会话历史')), IDLE_TIMEOUT_MS)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
  if (agent.status !== 'idle') throw rewindError('session-busy', '该会话仍在生成，未修改会话历史')
  assertNoPendingInput(agent)
}

function assertMutationReady(ctx, sessionId, session, agent) {
  if (requireSession(ctx, sessionId) !== session || requireAgent(ctx, sessionId) !== agent) {
    throw rewindError('session-changed', '会话已重新加载，请刷新后重试')
  }
  if (agent.status !== 'idle') throw rewindError('session-busy', '该会话开始了新的生成，请稍后重试')
  assertNoPendingInput(agent)
}

const MESSAGE_BLOCK_TYPES = new Set(['text', 'image', 'file'])

function attachmentBytes(value) {
  const bytes = value && Number(value.byteLength)
  return Number.isSafeInteger(bytes) && bytes >= 0 ? bytes : null
}

function checkedAttachmentBytes(value) {
  const bytes = attachmentBytes(value)
  if (bytes === null) throw rewindError('invalid-attachment', '附件读取结果无效')
  if (bytes > MAX_ATTACHMENT_BYTES) throw rewindError('attachment-too-large', '单个附件不能超过 16 MiB')
  return bytes
}

function decodeBase64(value) {
  if (typeof value !== 'string') throw rewindError('invalid-attachment', '附件内容不是有效的 Base64')
  if (value.length > MAX_BASE64_CHARS) throw rewindError('attachment-too-large', '单个附件不能超过 16 MiB')
  const data = Buffer.from(value, 'base64')
  if (data.toString('base64') !== value) throw rewindError('invalid-attachment', '附件内容不是有效的 Base64')
  if (data.byteLength > MAX_ATTACHMENT_BYTES) throw rewindError('attachment-too-large', '单个附件不能超过 16 MiB')
  return data
}

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
      continue
    }
    if (block.upload && typeof block.upload === 'object' && typeof block.upload.data === 'string') {
      kept.push({
        type: block.type,
        upload: {
          data: block.upload.data,
          name: typeof block.upload.name === 'string' ? block.upload.name : 'attachment',
          mediaType: typeof block.upload.mediaType === 'string' ? block.upload.mediaType : 'application/octet-stream',
        },
      })
    }
  }
  return kept
}

function userBlocksOf(session, seq) {
  const event = eventAt(session, seq)
  if (!event || event.type !== 'user/message' || event.data?.source?.kind !== 'user') return null
  return normaliseBlocks(event.data.content)
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
  const parts = []
  for (const block of content) {
    if (block.type === 'text') {
      parts.push(block)
      continue
    }
    if (!attachments) throw rewindError('attachments-unavailable', '附件服务不可用')
    if (block.type === 'image') {
      if (typeof attachments.readImage !== 'function') throw rewindError('unsupported', '当前附件存储不支持读取图片')
      const stored = await attachments.readImage(block.attachment)
      const bytes = checkedAttachmentBytes(stored && stored.data)
      parts.push({
        type: 'image',
        attachment: { ...block.attachment, ...(stored.ref || stored.attachment || {}) },
        encodedBytes: bytes,
      })
    } else {
      if (typeof attachments.readFileStream !== 'function') throw rewindError('unsupported', '当前附件存储不支持读取文件')
      // Drain the verified stream before changing history; missing files must fail here.
      let total = 0
      for await (const chunk of attachments.readFileStream(block.attachment)) {
        const bytes = attachmentBytes(chunk)
        if (bytes === null) throw rewindError('invalid-attachment', '附件读取结果无效')
        total += bytes
        if (total > MAX_ATTACHMENT_BYTES) throw rewindError('attachment-too-large', '单个附件不能超过 16 MiB')
      }
      parts.push(block)
    }
  }
  const admitted = attachments && typeof attachments.admitPromptContent === 'function'
    ? await attachments.admitPromptContent(parts)
    : parts
  // encodedBytes is admission metadata, not a persisted model-content field.
  return normaliseBlocks(admitted)
}

async function discardCreatedAttachments(ctx, created) {
  const attachments = ctx.get('attachments')
  if (!attachments || !Array.isArray(created)) return
  for (let index = created.length - 1; index >= 0; index -= 1) {
    const item = created[index]
    const method = item.kind === 'image'
      ? (attachments.deleteImage || attachments.removeImage)
      : (attachments.deleteFile || attachments.removeFile)
    if (typeof method !== 'function') continue
    try {
      await method.call(attachments, item.ref)
    } catch {
      /* Cleanup is best effort; the original operation error is more useful. */
    }
  }
}

async function materialiseUploads(ctx, content) {
  const attachments = ctx.get('attachments')
  const materialised = []
  const created = []
  try {
    for (const block of content) {
      if (!block.upload) {
        materialised.push(block)
        continue
      }
      if (!attachments) throw rewindError('attachments-unavailable', '附件服务不可用')
      const data = decodeBase64(block.upload.data)
      const name = block.upload.name || 'attachment'
      let ref
      if (block.type === 'image') {
        if (typeof attachments.saveImage !== 'function') throw rewindError('unsupported', '当前附件存储不支持保存图片')
        ref = await attachments.saveImage({ data, mediaType: block.upload.mediaType || 'image/png', name })
      } else {
        if (typeof attachments.saveFile !== 'function') throw rewindError('unsupported', '当前附件存储不支持保存文件')
        ref = await attachments.saveFile({ data, mediaType: block.upload.mediaType, name })
      }
      if (!ref || typeof ref !== 'object') throw rewindError('attachment-save-failed', '附件保存失败')
      created.push({ kind: block.type, ref })
      materialised.push({ type: block.type, attachment: ref })
    }
  } catch (error) {
    await discardCreatedAttachments(ctx, created)
    throw error
  }
  return { content: materialised, created }
}

async function prepareUserMessage(ctx, content) {
  const prepared = await materialiseUploads(ctx, content)
  try {
    const admitted = await admit(ctx, prepared.content)
    if (!Array.isArray(admitted) || admitted.length === 0) {
      throw rewindError('empty-message', '消息不能为空')
    }
    return {
      message: {
        id: randomUUID(),
        role: 'user',
        content: admitted,
        source: { kind: 'user', rpcId: randomUUID() },
      },
      created: prepared.created,
    }
  } catch (error) {
    await discardCreatedAttachments(ctx, prepared.created)
    throw error
  }
}

/* ------------------------------------------------------------------ */
/* operations                                                          */
/* ------------------------------------------------------------------ */

async function queueFollowup(agent, message) {
  let result
  try {
    result = agent.followup(message)
  } catch (error) {
    throw rewindError('followup-failed', error instanceof Error ? error.message : String(error))
  }
  try {
    // A synchronous followup is accepted immediately; await also captures
    // hosts that return a promise for asynchronous queue admission.
    await result
  } catch (error) {
    throw rewindError('followup-failed', error instanceof Error ? error.message : String(error))
  }
}

async function opEdit(ctx, body) {
  const sessionId = body.sessionId
  const session = requireSession(ctx, sessionId)
  const seq = body.seq
  if (!Number.isSafeInteger(seq) || seq < 0) throw rewindError('invalid-seq', '缺少有效的消息位置')
  const text = typeof body.text === 'string' ? body.text : ''
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
  if (text.trim() !== '') content.unshift({ type: 'text', text })
  if (content.length === 0) throw rewindError('empty-message', '消息不能为空')

  shadowSpan(session, seq) // Reject stale targets before stopping generation.
  const agent = requireAgent(ctx, sessionId)
  await ensureIdle(agent)
  assertMutationReady(ctx, sessionId, session, agent)
  let prepared
  let queued = false
  try {
    prepared = await prepareUserMessage(ctx, content)
    assertMutationReady(ctx, sessionId, session, agent)
    const span = shadowSpan(session, seq)
    // Queue first: a failed followup must leave the old history visible.
    await queueFollowup(agent, prepared.message)
    queued = true
    writeShadow(session, 'edit', span)
    await flushSession(ctx, session)
    return { shadowed: span.shadowed.length, blocks: prepared.message.content.length }
  } catch (error) {
    // Once followup has been accepted, its message may already reference the
    // newly saved attachments; cleanup is safe only before that boundary.
    if (prepared && !queued) await discardCreatedAttachments(ctx, prepared.created)
    throw error
  }
}

async function opRegenerate(ctx, body) {
  const sessionId = body.sessionId
  const session = requireSession(ctx, sessionId)
  const seq = body.seq
  if (!Number.isSafeInteger(seq) || seq < 0) throw rewindError('invalid-seq', '缺少有效的消息位置')

  const target = eventAt(session, seq)
  if (!target || target.type !== 'assistant/message') {
    throw rewindError('not-an-assistant-message', '只有助手回复可以重新生成')
  }
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

  const agent = requireAgent(ctx, sessionId)
  await ensureIdle(agent)
  assertMutationReady(ctx, sessionId, session, agent)
  if (!surfaceNodes(session).includes(seq)) throw rewindError('no-prompt', '这条回复已经不在上下文中')
  let prepared
  let queued = false
  try {
    prepared = await prepareUserMessage(ctx, content)
    assertMutationReady(ctx, sessionId, session, agent)
    if (!surfaceNodes(session).includes(seq)) throw rewindError('no-prompt', '这条回复已经不在上下文中')
    const span = shadowSpan(session, promptSeq)
    await queueFollowup(agent, prepared.message)
    queued = true
    writeShadow(session, 'regenerate', span)
    await flushSession(ctx, session)
    return { shadowed: span.shadowed.length, blocks: prepared.message.content.length }
  } catch (error) {
    if (prepared && !queued) await discardCreatedAttachments(ctx, prepared.created)
    throw error
  }
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
    checkedAttachmentBytes(stored && stored.data)
    const meta = (stored && (stored.ref || stored.attachment)) || {}
    return {
      name: meta.name || ref.name || 'image',
      mediaType: meta.mediaType || ref.mediaType || 'image/png',
      data: Buffer.from(stored.data).toString('base64'),
    }
  }

  if (typeof attachments.readFileStream !== 'function') throw rewindError('unsupported', '当前附件存储不支持读取文件')
  const chunks = []
  let total = 0
  for await (const chunk of attachments.readFileStream(ref)) {
    const bytes = attachmentBytes(chunk)
    if (bytes === null) throw rewindError('invalid-attachment', '附件读取结果无效')
    total += bytes
    if (total > MAX_ATTACHMENT_BYTES) throw rewindError('attachment-too-large', '单个附件不能超过 16 MiB')
    chunks.push(Buffer.from(chunk))
  }
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
  if (body.kind !== 'image' && body.kind !== 'file') throw rewindError('invalid-attachment', '未知附件类型')
  const data = decodeBase64(body.data)
  if (body.kind === 'image' && data.byteLength === 0) throw rewindError('invalid-attachment', '图片内容为空')
  const label = typeof body.name === 'string' && body.name !== '' ? body.name : 'attachment'

  if (body.kind === 'image') {
    if (typeof attachments.saveImage !== 'function') throw rewindError('unsupported', '当前附件存储不支持保存图片')
    const mediaType = typeof body.mediaType === 'string' ? body.mediaType : 'image/png'
    const ref = await attachments.saveImage({ data, mediaType, name: label })
    return { block: { type: 'image', attachment: ref } }
  }
  if (typeof attachments.saveFile !== 'function') throw rewindError('unsupported', '当前附件存储不支持保存文件')
  const ref = await attachments.saveFile({ data, name: label })
  return { block: { type: 'file', attachment: ref } }
}

/* ------------------------------------------------------------------ */
/* plugin                                                              */
/* ------------------------------------------------------------------ */

export function apply(ctx) {
  const activeSessions = new Set()
  const mutate = async (body, operation) => {
    const sessionId = body.sessionId
    if (activeSessions.has(sessionId)) throw rewindError('operation-in-progress', '该会话正在修改，请稍后重试')
    activeSessions.add(sessionId)
    try {
      return await operation(ctx, body)
    } finally {
      activeSessions.delete(sessionId)
    }
  }
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
  route('edit', body => mutate(body, opEdit))
  route('regenerate', body => mutate(body, opRegenerate))
  route('attachment', body => opAttachment(ctx, body))
  route('upload', body => opUpload(ctx, body))

  log('host ready')
}
