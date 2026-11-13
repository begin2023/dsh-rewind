/**
 * dsh-rewind - browser half.
 *
 * Adds message-level 编辑 / 撤回 / 重发 to a DSH conversation:
 *
 *   - a hover-revealed action row directly under every user message, rendered as
 *     a plugin-owned chat node kind so the official row renderer is never
 *     displaced,
 *   - 重新生成 / 撤回 on the official assistant action row,
 *   - a marker row wherever a range was folded away, which can put the original
 *     text AND every attachment back into the composer,
 *   - an editor that keeps the message's existing attachments and lets new ones
 *     be added, so rewriting a message never silently drops an image or a file.
 *
 * Old rows are hidden with a generated stylesheet keyed by chat node keys,
 * because the host's model-visible surface replacement deliberately leaves the
 * transcript the user already saw untouched.
 *
 * Hand-written bundle in the official __ModuleLoader__ format: no build step,
 * React from the browser module table.
 */

window.__ModuleLoader__.load({
  id: 'dsh-rewind',
  factory(require) {
    'use strict'

    const React = require('react')
    const h = React.createElement
    const useEffect = React.useEffect
    const useMemo = React.useMemo
    const useRef = React.useRef
    const useState = React.useState

    /** Chat node kind of the plugin-owned user action row. */
    const ACTIONS_KIND = 'rewind-actions'
    /** Chat node kind of the 'this range was folded away' marker row. */
    const MARKER_KIND = 'rewind-marker'
    /** Marker message ids written by the host half all start with this. */
    const MARKER_PREFIX = 'rewind:'
    /** Plugin stylesheet element id. */
    const STYLE_ID = 'dsh-rewind-style'
    /** Generated hide-rules element id. */
    const HIDE_STYLE_ID = 'dsh-rewind-hide'
    /** Media types the host stores and re-sends as images. */
    const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif']
    /** Marker kinds whose original content can go back to the composer. */
    const RESTORABLE = ['recall', 'edit']

    const CSS = ".dsh-rw-actions{display:flex;align-items:center;justify-content:flex-end;gap:2px;margin:-2px 6px 6px;opacity:.42;transition:opacity .14s ease}\n.dsh-rw-actions[data-active=\"true\"],.dsh-rw-actions:hover,.dsh-rw-actions:focus-within{opacity:1}\n.dsh-rw-btn{display:inline-flex;align-items:center;height:24px;padding:0 8px;border-radius:6px;border:0;background:transparent;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:1;font-family:inherit;cursor:pointer;transition:background .12s ease,color .12s ease}\n.dsh-rw-btn:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}\n.dsh-rw-btn[data-danger=\"true\"]:hover{background:var(--dsw-alias-interactive-bg-hover-danger,rgba(220,64,64,.14));color:var(--dsw-alias-state-error-primary)}\n.dsh-rw-btn:disabled{opacity:.4;cursor:default}\n.dsh-rw-icon{display:inline-flex;align-items:center;justify-content:center;width:22px;height:22px;padding:0;border:0;border-radius:5px;background:transparent;color:var(--dsw-alias-label-tertiary);cursor:pointer;transition:background .12s ease,color .12s ease}\n.dsh-rw-icon:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}\n.dsh-rw-icon[data-danger=\"true\"]:hover{color:var(--dsw-alias-state-error-primary)}\n.dsh-rw-icon:disabled{opacity:.35;cursor:default}\n.dsh-rw-icon svg{width:14px;height:14px;display:block}\n.dsh-rw-marker{display:flex;align-items:center;gap:10px;margin:8px 2px 12px;padding:7px 12px;border-radius:9px;border:1px dashed var(--dsw-alias-border-l3);background:var(--dsw-alias-bg-layer-2,transparent);color:var(--dsw-alias-label-tertiary);font-size:12.5px;line-height:1.5}\n.dsh-rw-marker-text{flex:1;min-width:0}\n.dsh-rw-chip{height:24px;padding:0 10px;border-radius:12px;border:1px solid var(--dsw-alias-border-l2);background:transparent;color:var(--dsw-alias-label-secondary);font-size:12px;font-family:inherit;cursor:pointer;white-space:nowrap}\n.dsh-rw-chip:hover{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-brand-primary)}\n.dsh-rw-backdrop{position:fixed;inset:0;z-index:2147483000;display:flex;align-items:center;justify-content:center;padding:24px;background:var(--dsw-alias-bg-mask-2,rgba(0,0,0,.42));animation:dsh-rw-fade .12s ease-out}\n.dsh-rw-dialog{width:min(660px,100%);max-height:calc(100vh - 96px);display:flex;flex-direction:column;border-radius:14px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3,#fff);box-shadow:0 20px 60px rgba(0,0,0,.32);overflow:hidden;animation:dsh-rw-rise .16s ease-out}\n.dsh-rw-dialog-head{display:flex;align-items:baseline;gap:8px;padding:16px 18px 10px}\n.dsh-rw-dialog-title{font-size:14.5px;font-weight:600;color:var(--dsw-alias-label-primary)}\n.dsh-rw-dialog-sub{font-size:12px;color:var(--dsw-alias-label-tertiary)}\n.dsh-rw-dialog-body{padding:0 18px;overflow:auto;flex:1;min-height:0}\n.dsh-rw-textarea{width:100%;box-sizing:border-box;min-height:96px;max-height:46vh;resize:vertical;padding:11px 12px;border-radius:10px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2,transparent);color:var(--dsw-alias-label-primary);font-size:13.5px;line-height:1.65;font-family:inherit;outline:none}\n.dsh-rw-textarea:focus{border-color:var(--dsw-alias-brand-primary)}\n.dsh-rw-files{display:flex;flex-wrap:wrap;gap:8px;margin-top:10px}\n.dsh-rw-file{position:relative;display:flex;align-items:center;gap:8px;padding:6px 8px;border-radius:9px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2,transparent);font-size:12px;color:var(--dsw-alias-label-secondary);max-width:220px}\n.dsh-rw-file-thumb{width:34px;height:34px;border-radius:6px;object-fit:cover;background:var(--dsw-alias-bg-layer-3,#8881);flex:none}\n.dsh-rw-file-icon{width:34px;height:34px;border-radius:6px;display:flex;align-items:center;justify-content:center;background:var(--dsw-alias-interactive-bg-hover);font-size:11px;color:var(--dsw-alias-label-tertiary);flex:none}\n.dsh-rw-file-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:140px}\n.dsh-rw-file-remove{position:absolute;top:-6px;right:-6px;width:18px;height:18px;border-radius:50%;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3,#fff);color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:1;cursor:pointer;display:flex;align-items:center;justify-content:center}\n.dsh-rw-file-remove:hover{color:var(--dsw-alias-state-error-primary);border-color:var(--dsw-alias-state-error-primary)}\n.dsh-rw-hint{margin:12px 0 4px;font-size:12px;line-height:1.6;color:var(--dsw-alias-label-tertiary)}\n.dsh-rw-error{margin:10px 0 4px;font-size:12px;color:var(--dsw-alias-state-error-primary)}\n.dsh-rw-dialog-foot{display:flex;align-items:center;gap:8px;padding:14px 18px 16px}\n.dsh-rw-foot-spacer{flex:1}\n.dsh-rw-ghost{height:32px;padding:0 14px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2);background:transparent;color:var(--dsw-alias-label-secondary);font-size:13px;font-family:inherit;cursor:pointer}\n.dsh-rw-ghost:hover{color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-border-l3)}\n.dsh-rw-primary{height:32px;padding:0 16px;border-radius:8px;border:0;background:var(--dsw-alias-brand-primary,#2f6bff);color:var(--dsw-alias-label-primary-foreground,#fff);font-size:13px;font-weight:500;font-family:inherit;cursor:pointer}\n.dsh-rw-primary:hover{background:var(--dsw-alias-button-primary-hover,var(--dsw-alias-brand-primary,#2f6bff))}\n.dsh-rw-primary:disabled,.dsh-rw-ghost:disabled{opacity:.5;cursor:default}\n.dsh-rw-danger{height:32px;padding:0 16px;border-radius:8px;border:0;background:var(--dsw-alias-state-error-primary,#d64545);color:#fff;font-size:13px;font-weight:500;font-family:inherit;cursor:pointer}\n.dsh-rw-danger:disabled{opacity:.5;cursor:default}\n.dsh-rw-toast{position:fixed;left:50%;bottom:104px;transform:translateX(-50%);z-index:2147483001;display:flex;align-items:center;gap:12px;max-width:min(560px,calc(100vw - 40px));padding:9px 14px;border-radius:10px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3,#20232a);color:var(--dsw-alias-label-primary);box-shadow:0 12px 34px rgba(0,0,0,.28);font-size:13px;animation:dsh-rw-fade .14s ease-out}\n.dsh-rw-toast-text{flex:1;min-width:0}\n.dsh-rw-toast-action{height:24px;padding:0 10px;border-radius:6px;border:0;background:var(--dsw-alias-brand-primary,#2f6bff);color:#fff;font-size:12px;font-family:inherit;cursor:pointer;white-space:nowrap}\n@keyframes dsh-rw-fade{from{opacity:0}to{opacity:1}}\n@keyframes dsh-rw-rise{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:none}}\n"

    const NO_STATE = () => undefined

    /* ------------------------------------------------------------------ */
    /* host bridge                                                         */
    /* ------------------------------------------------------------------ */

    let routeBase = 'api/dsh-rewind/'

    function bridgeError(code, message) {
      const error = new Error(message)
      error.code = code
      return error
    }

    async function callHost(op, body) {
      const send = async (base) => {
        const response = await fetch(base + op, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body === undefined ? {} : body),
        })
        const text = await response.text()
        let payload = null
        try {
          payload = JSON.parse(text)
        } catch {
          payload = null
        }
        return { response: response, payload: payload }
      }
      let result = await send(routeBase)
      if (result.payload === null && routeBase === 'api/dsh-rewind/') {
        routeBase = '/api/dsh-rewind/'
        result = await send(routeBase)
      }
      if (result.payload === null) throw bridgeError('route-missing', '宿主接口不可用：' + op)
      if (result.payload.ok !== true) {
        const info = result.payload.error || {}
        throw bridgeError(typeof info.code === 'string' ? info.code : 'failed', info.message || '操作失败')
      }
      return result.payload.value
    }

    function sleep(ms) {
      return new Promise((resolve) => {
        window.setTimeout(resolve, ms)
      })
    }

    function toBase64(bytes) {
      let binary = ''
      const step = 0x8000
      for (let index = 0; index < bytes.length; index += step) {
        binary += String.fromCharCode.apply(null, bytes.subarray(index, index + step))
      }
      return btoa(binary)
    }

    function fromBase64(text) {
      const binary = atob(text)
      const bytes = new Uint8Array(binary.length)
      for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
      return bytes
    }

    /* ------------------------------------------------------------------ */
    /* chat node helpers                                                   */
    /* ------------------------------------------------------------------ */

    /** Turn '13:input-message<id>' into '<id>' using the host key grammar. */
    function nodeKeyId(key) {
      if (typeof key !== 'string') return null
      const colon = key.indexOf(':')
      if (colon <= 0) return null
      const length = Number(key.slice(0, colon))
      if (!Number.isInteger(length) || length < 0) return null
      return key.slice(colon + 1 + length)
    }

    /**
     * A chat node that is NOT part of any Turn: 'unresolved' keeps it out of the
     * process groups, which is what makes it a real, always-visible row.
     */
    function chatNodeLike(context, kind, anchorSeq, data) {
      return {
        key: context.key,
        kind: kind,
        id: context.id,
        target: 'chat',
        anchorSeq: anchorSeq,
        location: { kind: 'unresolved' },
        visibility: 'visible',
        data: data,
      }
    }

    function isRewindMarkerEvent(event) {
      if (!event || event.type !== 'system/message') return false
      const op = event.surfaceOp
      if (!op || op === 'append') return false
      const message = event.data && event.data.message ? event.data.message : null
      const id = message ? message.id : undefined
      return typeof id === 'string' && id.indexOf(MARKER_PREFIX) === 0
    }

    function markerKindOf(event) {
      const message = event && event.data ? event.data.message : null
      const id = String(message && message.id ? message.id : '')
      const rest = id.slice(MARKER_PREFIX.length)
      const colon = rest.indexOf(':')
      return colon < 0 ? rest : rest.slice(0, colon)
    }

    function turnOfNode(node) {
      const located = node && node.location && node.location.turn ? node.location.turn.turn : undefined
      if (Number.isSafeInteger(located)) return located
      const declared = node && node.data ? node.data.turn : undefined
      return Number.isSafeInteger(declared) ? declared : null
    }

    const NON_CONTENT_KINDS = { 'turn-process': true, 'turn-tail': true }
    const OWN_KINDS = { 'rewind-actions': true, 'rewind-marker': true }

    /**
     * Map shadowed event seqs to the chat node keys that render them.
     *
     * A turn header is hidden as well when every content row of that turn is
     * hidden, so a fully folded turn does not leave an empty shell behind.
     */
    function hiddenKeysFor(seqs, nodes) {
      if (!Array.isArray(seqs) || seqs.length === 0) return null
      if (!nodes || typeof nodes.values !== 'function') return null
      const hidden = {}
      for (const seq of seqs) hidden[seq] = true
      const keys = []
      const processNodes = []
      const turnRows = {}
      for (const node of nodes.values()) {
        let covered = false
        if (node.kind === 'turn-tail') {
          const closing = node.data && node.data.closing ? node.data.closing.finalNode : null
          const closingSeq = closing ? closing.seq : undefined
          covered = typeof closingSeq === 'number' && hidden[closingSeq] === true
        } else if (node.kind === 'tool-call') {
          const root = node.data ? node.data.root : null
          const rootSeq = root ? root.seq : undefined
          covered = typeof rootSeq === 'number' && hidden[rootSeq] === true
        } else if (typeof node.anchorSeq === 'number') {
          const anchored = node.anchorSeq % 1 === 0 ? node.anchorSeq : Math.ceil(node.anchorSeq)
          covered = hidden[anchored] === true
        }
        if (covered) keys.push(node.key)
        if (OWN_KINDS[node.kind] === true) continue
        if (NON_CONTENT_KINDS[node.kind] === true) {
          if (node.kind === 'turn-process') processNodes.push({ node: node, covered: covered })
          continue
        }
        if (node.visibility === 'hidden') continue
        if (typeof node.anchorSeq !== 'number') continue
        const turn = turnOfNode(node)
        if (turn === null) continue
        const entry = turnRows[turn] || { rows: 0, hiddenRows: 0 }
        entry.rows += 1
        if (covered) entry.hiddenRows += 1
        turnRows[turn] = entry
      }
      for (const item of processNodes) {
        const turn = turnOfNode(item.node)
        if (turn === null) continue
        const entry = turnRows[turn]
        if (!entry || entry.rows === 0 || entry.hiddenRows !== entry.rows) continue
        if (keys.indexOf(item.node.key) >= 0) continue
        keys.push(item.node.key)
      }
      return keys.length === 0 ? null : keys
    }

    function quoteAttribute(value) {
      return '"' + String(value).split('"').join('') + '"'
    }

    function ruleFor(key) {
      const k = quoteAttribute(key)
      return (
        '[data-chat-anchor-key=' + k + '],' +
        '[data-chat-flow-key=' + k + '],' +
        '[data-chat-node-key=' + k + '],' +
        '[data-chat-anchor-key^=' + quoteAttribute('[' + key) + ']{display:none!important}'
      )
    }

    /**
     * Build hide rules. A null seqs value means 'every marker in the snapshot',
     * which is what the always-mounted controller publishes; a marker row
     * publishes only its own range so hiding survives even without a controller.
     */
    function hideCss(seqs, snapshot) {
      if (!snapshot || !snapshot.nodes) return ''
      let list = seqs
      if (list === null) {
        const collected = []
        for (const node of snapshot.nodes.values()) {
          if (node.kind !== MARKER_KIND) continue
          const shadowed = node.data && Array.isArray(node.data.shadowed) ? node.data.shadowed : []
          for (const seq of shadowed) collected.push(seq)
        }
        list = collected
      }
      if (list.length === 0) return ''
      const keys = hiddenKeysFor(list, snapshot.nodes)
      if (keys === null) return ''
      return keys.map(ruleFor).join('')
    }

    /** One stylesheet, several publishers (marker rows plus the controller). */
    const hidePublishers = new Map()

    function publishHide(owner, css) {
      if (css === '') hidePublishers.delete(owner)
      else hidePublishers.set(owner, css)
      let combined = ''
      for (const value of hidePublishers.values()) combined += value
      let tag = document.getElementById(HIDE_STYLE_ID)
      if (combined === '') {
        if (tag !== null && tag.parentNode !== null) tag.parentNode.removeChild(tag)
        return
      }
      if (tag === null) {
        tag = document.createElement('style')
        tag.id = HIDE_STYLE_ID
        document.head.appendChild(tag)
      }
      if (tag.textContent !== combined) tag.textContent = combined
    }

    /* ------------------------------------------------------------------ */
    /* toast                                                               */
    /* ------------------------------------------------------------------ */

    function showToast(text, action) {
      if (typeof document === 'undefined' || document.body === null) return function () {}
      const wrap = document.createElement('div')
      wrap.className = 'dsh-rw-toast'
      wrap.setAttribute('role', 'status')
      const label = document.createElement('div')
      label.className = 'dsh-rw-toast-text'
      label.textContent = text
      wrap.appendChild(label)
      let closed = false
      let timer = 0
      const close = () => {
        if (closed) return
        closed = true
        window.clearTimeout(timer)
        if (wrap.parentNode !== null) wrap.parentNode.removeChild(wrap)
      }
      if (action) {
        const button = document.createElement('button')
        button.type = 'button'
        button.className = 'dsh-rw-toast-action'
        button.textContent = action.label
        button.addEventListener('click', () => {
          close()
          try {
            action.run()
          } catch (error) {
            showToast(error && error.message ? error.message : '操作失败')
          }
        })
        wrap.appendChild(button)
      }
      document.body.appendChild(wrap)
      timer = window.setTimeout(close, action ? 9000 : 3400)
      return close
    }

    /* ------------------------------------------------------------------ */
    /* composer refill                                                     */
    /* ------------------------------------------------------------------ */

    function textOfBlocks(blocks) {
      const parts = []
      for (const block of blocks) {
        if (block && block.type === 'text' && typeof block.text === 'string') parts.push(block.text)
      }
      return parts.join(String.fromCharCode(10))
    }

    function attachmentLabel(block) {
      const attachment = block && block.attachment ? block.attachment : null
      if (attachment && typeof attachment.name === 'string' && attachment.name !== '') return attachment.name
      return block && block.type === 'image' ? '图片' : '文件'
    }

    function isAttachmentBlock(block) {
      return Boolean(block) && (block.type === 'image' || block.type === 'file')
    }

    async function waitUploads(conversation, ids) {
      const store = conversation && conversation.fileUploads
      if (!store || typeof store.getSnapshot !== 'function' || ids.length === 0) {
        await sleep(240)
        return
      }
      const deadline = Date.now() + 12000
      while (Date.now() < deadline) {
        const state = store.getSnapshot() || {}
        let pending = false
        for (const id of ids) {
          const entry = state[id]
          if (entry && entry.status === 'uploading') pending = true
        }
        if (!pending) {
          await sleep(80)
          return
        }
        await sleep(150)
      }
    }

    async function sendNow(sessionId, ids, inputActions) {
      const conversation = services.conversation()
      if (conversation) await waitUploads(conversation, ids)
      if (inputActions && typeof inputActions.submit === 'function') inputActions.submit()
    }

    /**
     * Put a message's text and EVERY attachment back into the composer.
     *
     * Text is written first and synchronously, so a slow attachment read can
     * never overwrite what the user has started typing in the meantime.
     */
    async function refillComposer(options) {
      const sessionId = options.sessionId
      const inputActions = options.inputActions
      const blocks = Array.isArray(options.blocks) ? options.blocks : []
      const text = textOfBlocks(blocks)
      const failed = []
      const outcome = { text: text !== '', attached: 0, ids: [], failed: failed, total: 0 }
      if (text !== '' && inputActions && typeof inputActions.setDraft === 'function') {
        inputActions.setDraft(text)
      }
      const attachments = blocks.filter(isAttachmentBlock)
      outcome.total = attachments.length
      if (attachments.length === 0) return outcome
      const files = []
      for (const block of attachments) {
        try {
          const payload = await callHost('attachment', {
            sessionId: sessionId,
            kind: block.type,
            attachment: block.attachment,
          })
          const bytes = fromBase64(payload.data)
          const name = payload.name || attachmentLabel(block)
          const type = payload.mediaType || 'application/octet-stream'
          files.push(new File([bytes], name, { type: type }))
        } catch (error) {
          failed.push(attachmentLabel(block) + '：' + (error && error.message ? error.message : String(error)))
        }
      }
      if (files.length === 0) return outcome
      const conversation = services.conversation()
      if (!conversation || typeof conversation.createDrafts !== 'function') {
        failed.push('附件通道不可用')
        return outcome
      }
      let drafts = []
      try {
        drafts = conversation.createDrafts(sessionId, files, true) || []
      } catch (error) {
        failed.push('无法创建附件草稿：' + (error && error.message ? error.message : String(error)))
        return outcome
      }
      let ids = drafts.map((draft) => (draft ? draft.id : '')).filter((id) => typeof id === 'string' && id !== '')
      if (ids.length > 0 && typeof conversation.resolveDraftAttachments === 'function') {
        try {
          const live = conversation.resolveDraftAttachments(ids) || []
          const liveIds = {}
          for (const item of live) {
            if (item && typeof item.id === 'string') liveIds[item.id] = true
          }
          const kept = ids.filter((id) => liveIds[id] === true)
          const dropped = drafts.filter((draft) => !draft || liveIds[draft.id] !== true)
          if (dropped.length > 0 && typeof conversation.releaseDraftAttachments === 'function') {
            conversation.releaseDraftAttachments(dropped)
          }
          ids = kept
        } catch {
          /* registry view unavailable: keep every id */
        }
      }
      let accepted = false
      if (ids.length > 0 && inputActions && typeof inputActions.addAttachments === 'function') {
        try {
          accepted = inputActions.addAttachments(ids) === true
        } catch {
          accepted = false
        }
      }
      if (!accepted) {
        if (typeof conversation.releaseDraftAttachments === 'function') conversation.releaseDraftAttachments(drafts)
        failed.push('无法放入输入框')
        return outcome
      }
      outcome.attached = ids.length
      outcome.ids = ids
      return outcome
    }

    function describeRefill(outcome) {
      const parts = []
      if (outcome.text) parts.push('文字')
      if (outcome.attached > 0) parts.push(outcome.attached + ' 个附件')
      return parts.join('、')
    }

    async function refillAndAnnounce(options) {
      let outcome
      try {
        outcome = await refillComposer(options)
      } catch (error) {
        showToast(error && error.message ? error.message : '放回失败')
        return
      }
      const summary = describeRefill(outcome)
      if (summary === '') {
        showToast(outcome.failed.length > 0 ? '放回失败：' + outcome.failed[0] : '这条消息没有可放回的内容')
        return
      }
      const ids = outcome.ids || []
      showToast('已放回输入框：' + summary, {
        label: '立即发送',
        run: () => {
          void sendNow(options.sessionId, ids, options.inputActions)
        },
      })
      if (outcome.failed.length > 0) showToast('有附件未能放回：' + outcome.failed[0])
    }

    /* ------------------------------------------------------------------ */
    /* hover linkage between a message row and its action row              */
    /* ------------------------------------------------------------------ */

    const actionRows = new Map()
    let activeRowKey = null

    function setActiveRow(key) {
      if (key === activeRowKey) return
      activeRowKey = key
      for (const entry of actionRows) {
        const element = entry[1]
        if (!element) continue
        if (entry[0] === key) element.setAttribute('data-active', 'true')
        else element.removeAttribute('data-active')
      }
    }

    function handlePointer(event) {
      const target = event.target
      if (!target || typeof target.closest !== 'function') {
        setActiveRow(null)
        return
      }
      const seat = target.closest('[data-chat-node-key]')
      if (seat === null) {
        setActiveRow(null)
        return
      }
      const key = seat.getAttribute('data-chat-node-key') || ''
      if (key === '') {
        setActiveRow(null)
        return
      }
      if (actionRows.has(key)) {
        setActiveRow(key)
        return
      }
      const id = nodeKeyId(key)
      if (id === null) {
        setActiveRow(null)
        return
      }
      const candidate = String(ACTIONS_KIND.length) + ':' + ACTIONS_KIND + id
      setActiveRow(actionRows.has(candidate) ? candidate : null)
    }

    function handleOut(event) {
      if (event.relatedTarget === null || event.relatedTarget === undefined) setActiveRow(null)
    }

    /* ------------------------------------------------------------------ */
    /* dialogs                                                             */
    /*                                                                     */
    /* Plain DOM appended straight to document.body — deliberately not      */
    /* React children of the message row. The transcript lives inside a     */
    /* scroll container that declares container-type: inline-size, and      */
    /* layout containment makes that element the containing block for every */
    /* position: fixed descendant. An overlay rendered inside a message row */
    /* therefore scrolls away with the transcript and is clipped by the     */
    /* scroller, which is exactly why the editor used to open nowhere       */
    /* visible. Owning the DOM keeps the dialog centred on the viewport     */
    /* wherever the row happens to be.                                      */
    /* ------------------------------------------------------------------ */

    const openDialogs = []

    function dom(tag, props, children) {
      const node = document.createElement(tag)
      if (props) {
        for (const key of Object.keys(props)) {
          const value = props[key]
          if (value === null || value === undefined || value === false) continue
          if (key === 'class') node.className = String(value)
          else if (key === 'text') node.textContent = String(value)
          else if (key === 'style') node.style.cssText = String(value)
          else node.setAttribute(key, value === true ? '' : String(value))
        }
      }
      if (Array.isArray(children)) {
        for (const child of children) if (child) node.appendChild(child)
      }
      return node
    }

    function focusableIn(card) {
      const all = Array.prototype.slice.call(card.querySelectorAll('button, textarea, input, [tabindex]'))
      const out = []
      for (const node of all) {
        if (node.disabled) continue
        if (node.getAttribute('tabindex') === '-1') continue
        out.push(node)
      }
      return out
    }

    function mountDialog(options) {
      const backdrop = dom('div', { class: 'dsh-rw-backdrop' })
      const card = dom('div', { class: 'dsh-rw-dialog', role: 'dialog', 'aria-modal': 'true' })
      card.appendChild(
        dom('div', { class: 'dsh-rw-dialog-head' }, [
          dom('div', { class: 'dsh-rw-dialog-title', text: options.title }),
          options.sub ? dom('div', { class: 'dsh-rw-dialog-sub', text: options.sub }) : null,
        ]),
      )
      card.appendChild(dom('div', { class: 'dsh-rw-dialog-body' }, options.body))
      card.appendChild(dom('div', { class: 'dsh-rw-dialog-foot' }, options.footer))
      backdrop.appendChild(card)
      const previous = document.activeElement
      let closed = false
      const handle = { card: card, close: null, isClosed: function () { return closed } }

      function onKeyDown(event) {
        if (event.key === 'Escape') {
          event.preventDefault()
          event.stopPropagation()
          close()
          return
        }
        if (event.key !== 'Tab') return
        const focusable = focusableIn(card)
        if (focusable.length === 0) return
        const first = focusable[0]
        const last = focusable[focusable.length - 1]
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault()
          last.focus()
          return
        }
        if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault()
          first.focus()
        }
      }

      function close() {
        if (closed) return
        closed = true
        document.removeEventListener('keydown', onKeyDown, true)
        if (backdrop.parentNode !== null) backdrop.parentNode.removeChild(backdrop)
        const at = openDialogs.indexOf(handle)
        if (at >= 0) openDialogs.splice(at, 1)
        try {
          if (previous && previous.isConnected && typeof previous.focus === 'function') previous.focus()
        } catch (problem) {
          /* the row may already be gone */
        }
        if (typeof options.onClose === 'function') options.onClose()
      }

      handle.close = close
      document.addEventListener('keydown', onKeyDown, true)
      backdrop.addEventListener('mousedown', function (event) {
        if (card.contains(event.target)) return
        close()
      })
      /* Keep wheel/trackpad scrolling inside the dialog: the chat transcript
         behind the mask must not move while a dialog is open. */
      backdrop.addEventListener(
        'wheel',
        function (event) {
          if (card.contains(event.target)) return
          event.preventDefault()
        },
        { passive: false },
      )
      document.body.appendChild(backdrop)
      openDialogs.push(handle)
      return handle
    }

    function closeAllDialogs() {
      const all = openDialogs.slice()
      for (const handle of all) {
        try {
          handle.close()
        } catch (problem) {
          /* ignore */
        }
      }
    }

    function openRecallDialog(options) {
      const assistant = options.role === 'assistant'
      const errorLine = dom('div', { class: 'dsh-rw-error' })
      errorLine.style.display = 'none'
      const hint = dom('div', {
        class: 'dsh-rw-hint',
        text: assistant
          ? '撤回后，这条回复以及它之后的内容会从模型上下文中移除。界面上它们会折叠成一行提示，之后继续对话时模型不会记得它们。'
          : '撤回后，这条消息以及它之后的所有内容会从模型上下文中移除。界面上它们会折叠成一行提示，之后继续对话时模型不会记得它们。想重新发送，可以从那行提示里把文字和附件放回输入框。',
      })
      const cancelButton = dom('button', { type: 'button', class: 'dsh-rw-ghost', text: '取消' })
      const confirmButton = dom('button', { type: 'button', class: 'dsh-rw-danger', text: '撤回' })
      let busy = false
      const handle = mountDialog({
        title: assistant ? '撤回这条回复' : '撤回这条消息',
        sub: '从模型上下文中移除',
        body: [hint, errorLine],
        footer: [dom('div', { class: 'dsh-rw-foot-spacer' }), cancelButton, confirmButton],
        onClose: options.onClose,
      })
      cancelButton.addEventListener('click', function () {
        handle.close()
      })
      confirmButton.addEventListener('click', function () {
        if (busy) return
        busy = true
        confirmButton.disabled = true
        cancelButton.disabled = true
        confirmButton.textContent = '撤回中…'
        errorLine.style.display = 'none'
        void (async function () {
          try {
            const value = await callHost('recall', { sessionId: options.sessionId, seq: options.seq })
            handle.close()
            const count = value && typeof value.shadowed === 'number' ? value.shadowed : 0
            showToast(count > 0 ? '已撤回，模型上下文里移除了 ' + count + ' 条内容' : '已撤回')
          } catch (problem) {
            errorLine.textContent = problem && problem.message ? problem.message : '撤回失败'
            errorLine.style.display = ''
            confirmButton.disabled = false
            cancelButton.disabled = false
            confirmButton.textContent = '撤回'
          } finally {
            busy = false
          }
        })()
      })
      confirmButton.focus()
      return handle
    }

    function openEditDialog(options) {
      const sessionId = options.sessionId
      const seq = options.seq
      const source = Array.isArray(options.blocks) ? options.blocks : []
      const items = source.filter(isAttachmentBlock).map(function (block, position) {
        const attachment = block.attachment || {}
        return {
          key: 'existing-' + position + '-' + String(attachment.attachmentId || position),
          block: block,
          name: attachmentLabel(block),
          mediaType: attachment.mediaType || '',
          isImage: block.type === 'image',
          preview: '',
        }
      })
      const objectUrls = []
      let busy = false

      const textarea = dom('textarea', {
        class: 'dsh-rw-textarea',
        placeholder: '输入新的内容…',
        spellcheck: 'false',
      })
      textarea.value = textOfBlocks(source)
      const chips = dom('div', { class: 'dsh-rw-files' })
      const errorLine = dom('div', { class: 'dsh-rw-error' })
      errorLine.style.display = 'none'
      const hint = dom('div', {
        class: 'dsh-rw-hint',
        text: '保存后，这条消息以及它之后的内容会从模型上下文中移除，然后按新内容重新提问。原有附件会一起带上，除非你在这里移除它。',
      })
      const filePicker = dom('input', { type: 'file', multiple: 'multiple' })
      filePicker.style.display = 'none'
      const addButton = dom('button', { type: 'button', class: 'dsh-rw-ghost', text: '添加图片或文件' })
      const cancelButton = dom('button', { type: 'button', class: 'dsh-rw-ghost', text: '取消' })
      const saveButton = dom('button', { type: 'button', class: 'dsh-rw-primary', text: '保存并重新发送' })

      const handle = mountDialog({
        title: '编辑消息',
        sub: '保存后重新发送',
        body: [textarea, chips, hint, errorLine],
        footer: [
          filePicker,
          addButton,
          dom('div', { class: 'dsh-rw-foot-spacer' }),
          cancelButton,
          saveButton,
        ],
        onClose: function () {
          for (const url of objectUrls) {
            try {
              URL.revokeObjectURL(url)
            } catch (problem) {
              /* ignore */
            }
          }
          if (typeof options.onClose === 'function') options.onClose()
        },
      })

      function setBusy(next) {
        busy = next
        saveButton.disabled = next
        cancelButton.disabled = next
        addButton.disabled = next
        saveButton.textContent = next ? '保存中…' : '保存并重新发送'
      }

      function setError(message) {
        errorLine.textContent = message || ''
        errorLine.style.display = message ? '' : 'none'
      }

      function removeItem(key) {
        for (let index = items.length - 1; index >= 0; index -= 1) {
          if (items[index].key === key) items.splice(index, 1)
        }
        renderChips()
      }

      function renderChips() {
        chips.textContent = ''
        chips.style.display = items.length === 0 ? 'none' : ''
        for (const item of items) {
          const chip = dom('div', { class: 'dsh-rw-file' })
          if (item.isImage && item.preview) {
            const image = dom('img', { class: 'dsh-rw-file-thumb', alt: '' })
            image.src = item.preview
            chip.appendChild(image)
          } else {
            chip.appendChild(dom('div', { class: 'dsh-rw-file-icon', text: item.isImage ? '图片' : '文件' }))
          }
          chip.appendChild(dom('div', { class: 'dsh-rw-file-name', title: item.name, text: item.name }))
          const remove = dom('button', {
            type: 'button',
            class: 'dsh-rw-file-remove',
            title: '移除这个附件',
            text: '×',
          })
          remove.addEventListener('click', function () {
            removeItem(item.key)
          })
          chip.appendChild(remove)
          chips.appendChild(chip)
        }
      }

      function addFiles(fileList) {
        const stamp = Date.now()
        let position = 0
        for (const file of fileList) {
          const item = {
            key: 'new-' + stamp + '-' + position + '-' + file.name,
            block: null,
            file: file,
            name: file.name,
            mediaType: file.type || '',
            isImage: IMAGE_TYPES.indexOf(file.type) >= 0,
            preview: '',
          }
          if (item.isImage && typeof URL !== 'undefined' && typeof URL.createObjectURL === 'function') {
            try {
              item.preview = URL.createObjectURL(file)
              objectUrls.push(item.preview)
            } catch (problem) {
              item.preview = ''
            }
          }
          items.push(item)
          position += 1
        }
        renderChips()
      }

      function loadPreviews() {
        for (const item of items) {
          if (!item.isImage || !item.block || item.preview || item.loading) continue
          item.loading = true
          void (async function () {
            try {
              const payload = await callHost('attachment', {
                sessionId: sessionId,
                kind: 'image',
                attachment: item.block.attachment,
              })
              item.preview = 'data:' + (payload.mediaType || 'image/png') + ';base64,' + payload.data
            } catch (problem) {
              item.preview = ''
            }
            renderChips()
          })()
        }
      }

      async function save() {
        if (busy) return
        setBusy(true)
        setError('');
        try {
          const add = []
          for (const item of items) {
            if (!item.file) continue
            const buffer = await item.file.arrayBuffer()
            const payload = await callHost('upload', {
              sessionId: sessionId,
              kind: item.isImage ? 'image' : 'file',
              name: item.file.name,
              mediaType: item.file.type || 'application/octet-stream',
              data: toBase64(new Uint8Array(buffer)),
            })
            if (payload && payload.block) add.push(payload.block)
          }
          const keep = []
          for (const item of items) {
            if (item.file) continue
            const attachment = item.block ? item.block.attachment : null
            const id = attachment ? attachment.attachmentId : undefined
            if (typeof id === 'string') keep.push(id)
          }
          await callHost('edit', {
            sessionId: sessionId,
            seq: seq,
            text: textarea.value,
            keep: keep,
            add: add,
          })
          handle.close()
          showToast('已保存并重新发送')
        } catch (problem) {
          setError(problem && problem.message ? problem.message : '保存失败')
        } finally {
          setBusy(false)
        }
      }

      textarea.addEventListener('keydown', function (event) {
        if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
          event.preventDefault()
          void save()
        }
      })
      textarea.addEventListener('paste', function (event) {
        const clipboard = event.clipboardData
        const files = clipboard && clipboard.files ? Array.prototype.slice.call(clipboard.files) : []
        if (files.length === 0) return
        event.preventDefault()
        addFiles(files)
      })
      filePicker.addEventListener('change', function () {
        addFiles(Array.prototype.slice.call(filePicker.files || []))
        filePicker.value = ''
      })
      addButton.addEventListener('click', function () {
        filePicker.click()
      })
      cancelButton.addEventListener('click', function () {
        handle.close()
      })
      saveButton.addEventListener('click', function () {
        void save()
      })
      handle.card.addEventListener('dragover', function (event) {
        event.preventDefault()
        handle.card.setAttribute('data-drop', 'true')
      })
      handle.card.addEventListener('dragleave', function () {
        handle.card.removeAttribute('data-drop')
      })
      handle.card.addEventListener('drop', function (event) {
        event.preventDefault()
        handle.card.removeAttribute('data-drop')
        const transfer = event.dataTransfer
        const files = transfer && transfer.files ? Array.prototype.slice.call(transfer.files) : []
        if (files.length > 0) addFiles(files)
      })

      renderChips()
      loadPreviews()
      try {
        textarea.focus()
        const end = textarea.value.length
        if (typeof textarea.setSelectionRange === 'function') textarea.setSelectionRange(end, end)
      } catch (problem) {
        /* ignore */
      }
      return handle
    }

    /* ------------------------------------------------------------------ */
    /* user message action row                                             */
    /* ------------------------------------------------------------------ */

    function UserActionsRow(props) {
      const node = props.node
      const sessionId = props.sessionId
      const inputActions = props.inputActions
      const data = node && node.data ? node.data : {}
      const seq = data.seq
      const blocks = Array.isArray(data.content) ? data.content : []
      const rowKey = node ? node.key : ''
      const [busy, setBusy] = useState(false)
      const busyRef = useRef(false)

      useEffect(
        () => () => {
          actionRows.delete(rowKey)
        },
        [rowKey],
      )

      const attach = (element) => {
        if (element === null) actionRows.delete(rowKey)
        else actionRows.set(rowKey, element)
      }

      const guard = async (task) => {
        if (busyRef.current) return
        busyRef.current = true
        setBusy(true)
        try {
          await task()
        } catch (error) {
          showToast(error && error.message ? error.message : '操作失败')
        } finally {
          busyRef.current = false
          setBusy(false)
        }
      }

      const resend = () =>
        guard(() => refillAndAnnounce({ sessionId: sessionId, inputActions: inputActions, blocks: blocks }))

      return h(
        'div',
        { className: 'dsh-rw-actions', ref: attach },
        h(
          'button',
          {
            type: 'button',
            className: 'dsh-rw-btn',
            disabled: busy,
            title: '编辑这条消息',
            onClick: () => openEditDialog({ sessionId: sessionId, seq: seq, blocks: blocks }),
          },
          '编辑',
        ),
        h(
          'button',
          {
            type: 'button',
            className: 'dsh-rw-btn',
            disabled: busy,
            title: '把文字和全部附件放回输入框',
            onClick: resend,
          },
          '重发',
        ),
        h(
          'button',
          {
            type: 'button',
            className: 'dsh-rw-btn',
            'data-danger': 'true',
            disabled: busy,
            title: '撤回这条消息以及它之后的内容',
            onClick: () => openRecallDialog({ sessionId: sessionId, seq: seq, role: 'user' }),
          },
          '撤回',
        ),
      )
    }

    /* ------------------------------------------------------------------ */
    /* assistant actions                                                   */
    /* ------------------------------------------------------------------ */

    function assistantSeqOf(snapshot, messageId) {
      if (!snapshot || !snapshot.nodes || typeof messageId !== 'string' || messageId === '') return undefined
      for (const node of snapshot.nodes.values()) {
        const final = node.data && node.data.finalNode ? node.data.finalNode : null
        if (final && final.messageId === messageId && typeof final.seq === 'number') return final.seq
      }
      for (const node of snapshot.nodes.values()) {
        if (node.kind === 'assistant-step' && node.id === messageId && typeof node.anchorSeq === 'number') {
          return node.anchorSeq
        }
      }
      return undefined
    }

    function iconRefresh() {
      return h(
        'svg',
        { viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', strokeWidth: '1.5', strokeLinecap: 'round' },
        h('path', { d: 'M13 8a5 5 0 1 1-1.6-3.7' }),
        h('path', { d: 'M13 2.4V5.2h-2.8' }),
      )
    }

    function iconUndo() {
      return h(
        'svg',
        { viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', strokeWidth: '1.5', strokeLinecap: 'round' },
        h('path', { d: 'M3.5 8a4.5 4.5 0 0 1 9 0' }),
        h('path', { d: 'M3.5 4.6V8h3.4' }),
      )
    }

    function AssistantActions(props) {
      const sessionId = props.sessionId
      const messageId = props.messageId
      const useChat = typeof props.useChat === 'function' ? props.useChat : NO_STATE
      const seq = useChat((snapshot) => assistantSeqOf(snapshot, messageId))
      const [busy, setBusy] = useState(false)
      const busyRef = useRef(false)
      const ready = typeof seq === 'number'

      const regenerate = async () => {
        if (busyRef.current || !ready) return
        busyRef.current = true
        setBusy(true)
        try {
          await callHost('regenerate', { sessionId: sessionId, seq: seq })
          showToast('已按原来的提问重新生成')
        } catch (error) {
          showToast(error && error.message ? error.message : '重新生成失败')
        } finally {
          busyRef.current = false
          setBusy(false)
        }
      }

      return h(
        'span',
        { className: 'dsh-rw-icons' },
        h(
          'button',
          {
            type: 'button',
            className: 'dsh-rw-icon',
            disabled: busy || !ready,
            title: '重新生成这条回复',
            onClick: regenerate,
          },
          iconRefresh(),
        ),
        h(
          'button',
          {
            type: 'button',
            className: 'dsh-rw-icon',
            'data-danger': 'true',
            disabled: busy || !ready,
            title: '撤回这条回复以及它之后的内容',
            onClick: () => openRecallDialog({ sessionId: sessionId, seq: seq, role: 'assistant' }),
          },
          iconUndo(),
        ),
      )
    }

    /* ------------------------------------------------------------------ */
    /* marker row                                                          */
    /* ------------------------------------------------------------------ */

    function findUserDataAt(snapshot, seq) {
      if (!snapshot || !snapshot.nodes || typeof seq !== 'number') return null
      for (const node of snapshot.nodes.values()) {
        if (node.kind !== 'user') continue
        const data = node.data
        if (!data) continue
        if (data.seq === seq || node.anchorSeq === seq) return data
      }
      return null
    }

    function MarkerRow(props) {
      const node = props.node
      const sessionId = props.sessionId
      const inputActions = props.inputActions
      const useChat = typeof props.useChat === 'function' ? props.useChat : NO_STATE
      const data = node && node.data ? node.data : {}
      const shadowed = Array.isArray(data.shadowed) ? data.shadowed : []
      const kind = data.kind
      const startSeq = data.startSeq
      const signature = shadowed.join(',')
      const snapshot = useChat((state) => state)
      const css = useMemo(() => hideCss(shadowed, snapshot), [signature, snapshot])
      const rowKey = node ? node.key : ''

      useEffect(() => {
        publishHide(rowKey, css)
        return () => publishHide(rowKey, '')
      }, [css, rowKey])

      const source = useMemo(() => findUserDataAt(snapshot, startSeq), [snapshot, startSeq])
      const count = shadowed.length

      let label = '已撤回 ' + count + ' 条内容，模型不会再看到它们'
      if (kind === 'edit') label = '这条消息已被编辑，旧的 ' + count + ' 条内容已从上下文移除'
      else if (kind === 'regenerate') label = '已重新生成，旧的 ' + count + ' 条内容已从上下文移除'

      const restore = async () => {
        if (!source) {
          showToast('原始内容已不在聊天记录里，无法放回')
          return
        }
        const blocks = Array.isArray(source.content) ? source.content : []
        await refillAndAnnounce({ sessionId: sessionId, inputActions: inputActions, blocks: blocks })
      }

      return h(
        'div',
        { className: 'dsh-rw-marker' },
        h('div', { className: 'dsh-rw-marker-text' }, label),
        RESTORABLE.indexOf(kind) >= 0
          ? h('button', { type: 'button', className: 'dsh-rw-chip', onClick: () => void restore() }, '放回输入框')
          : null,
      )
    }

    /* ------------------------------------------------------------------ */
    /* always-mounted hide controller                                      */
    /* ------------------------------------------------------------------ */

    function HideSync(props) {
      const useChat = typeof props.useChat === 'function' ? props.useChat : NO_STATE
      const snapshot = useChat((state) => state)
      const css = useMemo(() => hideCss(null, snapshot), [snapshot])
      const owner = String(props.owner || 'sync')
      useEffect(() => {
        publishHide(owner, css)
        return () => publishHide(owner, '')
      }, [css, owner])
      return null
    }

    /* ------------------------------------------------------------------ */
    /* conversation definitions                                            */
    /* ------------------------------------------------------------------ */

    const actionsDefinition = {
      kind: ACTIONS_KIND,
      target: 'chat',
      match: (event) => {
        if (!event || event.type !== 'user/message') return null
        if (event.surfaceOp !== undefined && event.surfaceOp !== 'append') return null
        const source = event.data ? event.data.source : null
        if (!source || (source.kind !== 'user' && source.kind !== 'goal')) return null
        const id = event.data.id
        if (typeof id !== 'string' || id === '') return null
        return { id: id, role: 'start' }
      },
      start: (context, match) => ({
        seq: match.event.seq,
        time: match.event.time,
        messageId: String(match.event.data.id),
        content: match.event.data.content,
      }),
      update: (context) => context.state,
      buildViewNode: (context) => chatNodeLike(context, ACTIONS_KIND, context.state.seq, context.state),
    }

    const markerDefinition = {
      kind: MARKER_KIND,
      target: 'chat',
      match: (event) => {
        if (!isRewindMarkerEvent(event)) return null
        return { id: String(event.seq), role: 'start' }
      },
      start: (context, match) => {
        const op = match.event.surfaceOp || {}
        const startSeq = typeof op.startSeq === 'number' ? op.startSeq : op.start
        const endSeq = typeof op.endSeq === 'number' ? op.endSeq : op.end
        return {
          seq: match.event.seq,
          time: match.event.time,
          kind: markerKindOf(match.event),
          startSeq: typeof startSeq === 'number' ? startSeq : undefined,
          endSeq: typeof endSeq === 'number' ? endSeq : undefined,
          shadowed: Array.isArray(match.event.sourceEventSeqs) ? match.event.sourceEventSeqs.slice() : [],
        }
      },
      update: (context) => context.state,
      buildViewNode: (context) => chatNodeLike(context, MARKER_KIND, context.state.seq, context.state),
    }

    function conversationRegistrar(service) {
      if (!service) return null
      if (service.events && typeof service.events.register === 'function') {
        return { register: (definition) => service.events.register(definition), via: 'events' }
      }
      if (typeof service.register === 'function') {
        return { register: (definition) => service.register(definition), via: 'self' }
      }
      return null
    }

    /* ------------------------------------------------------------------ */
    /* plugin                                                              */
    /* ------------------------------------------------------------------ */

    const services = {
      conversation: () => null,
      sessions: () => null,
    }

    let definitionsRegistered = false

    function apply(ctx) {
      services.conversation = () => {
        try {
          return ctx.get('conversation') || null
        } catch {
          return null
        }
      }
      services.sessions = () => {
        try {
          return ctx.get('sessions') || null
        } catch {
          return null
        }
      }

      const log = (...args) => {
        try {
          const logger = typeof ctx.logger === 'function' ? ctx.logger('rewind') : undefined
          if (logger && typeof logger.warn === 'function') logger.warn(...args)
          else console.warn('[dsh-rewind]', ...args)
        } catch {
          /* logging must never break the UI */
        }
      }

      ctx.effect(() => {
        if (typeof document === 'undefined') return undefined
        const previous = document.getElementById(STYLE_ID)
        if (previous !== null) previous.remove()
        const style = document.createElement('style')
        style.id = STYLE_ID
        style.textContent = CSS
        document.head.appendChild(style)
        return () => {
          const live = document.getElementById(STYLE_ID)
          if (live !== null) live.remove()
          const hide = document.getElementById(HIDE_STYLE_ID)
          if (hide !== null) hide.remove()
        }
      }, 'dsh-rewind: styles')

      ctx.effect(() => {
        document.addEventListener('mouseover', handlePointer, true)
        document.addEventListener('mouseout', handleOut, true)
        return () => {
          document.removeEventListener('mouseover', handlePointer, true)
          document.removeEventListener('mouseout', handleOut, true)
        }
      }, 'dsh-rewind: hover linkage')

      const registerDefinitions = (serviceName, service) => {
        if (definitionsRegistered) return true
        const registrar = conversationRegistrar(service)
        if (registrar === null) return false
        let disposers
        try {
          disposers = [registrar.register(actionsDefinition), registrar.register(markerDefinition)]
        } catch (error) {
          log('conversation definitions failed (' + serviceName + '): ' + (error && error.message))
          return false
        }
        definitionsRegistered = true
        log('conversation definitions registered via ' + serviceName + '.' + registrar.via)
        ctx.effect(
          () => () => {
            definitionsRegistered = false
            for (const dispose of disposers) {
              try {
                dispose()
              } catch {
                /* idempotent disposer */
              }
            }
          },
          'dsh-rewind: definitions',
        )
        return true
      }

      if (!registerDefinitions('uiConversation', ctx.get('uiConversation'))) {
        ctx.inject(['uiConversation'], (child) => {
          registerDefinitions('uiConversation', child.get('uiConversation'))
        })
      }

      const mount = (seat, register) => {
        ctx.slots.inject(seat, () => {
          try {
            return register()
          } catch (error) {
            log('slot mount failed (' + seat + '): ' + (error && error.message))
            return () => {}
          }
        })
      }

      mount('conversation.chat.node', () =>
        ctx.slots.register({ name: 'conversation.chat.node', key: ACTIONS_KIND }, UserActionsRow),
      )
      mount('conversation.chat.node', () =>
        ctx.slots.register({ name: 'conversation.chat.node', key: MARKER_KIND }, MarkerRow),
      )
      mount('conversation.chat.assistant-actions', () =>
        ctx.slots.register({ name: 'conversation.chat.assistant-actions', id: 'rewind', order: 40 }, AssistantActions),
      )
      mount('conversation.input.dock', () =>
        ctx.slots.register(
          {
            name: 'conversation.input.dock',
            id: 'rewind-hide-sync',
            order: 90,
            inject: () => ({ owner: 'sync:dock' }),
          },
          HideSync,
        ),
      )

      log('client ready')
    }

    /** Internals exposed for the offline smoke test (no runtime consumer). */
    const __test = {
      nodeKeyId: nodeKeyId,
      UserActionsRow: UserActionsRow,
      AssistantActions: AssistantActions,
      MarkerRow: MarkerRow,
      HideSync: HideSync,
      mountDialog: mountDialog,
      openEditDialog: openEditDialog,
      openRecallDialog: openRecallDialog,
      closeAllDialogs: closeAllDialogs,
      hiddenKeysFor: hiddenKeysFor,
      hideCss: hideCss,
      textOfBlocks: textOfBlocks,
      actionsDefinition: actionsDefinition,
      markerDefinition: markerDefinition,
      ACTIONS_KIND: ACTIONS_KIND,
      MARKER_KIND: MARKER_KIND,
    }

    return {
      inject: ['slots'],
      apply: apply,
      __test: __test,
    }
  },
})
