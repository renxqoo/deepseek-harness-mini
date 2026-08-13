/**
 * Session — append-only 事件日志，deepseek-harness 的唯一真相来源
 *
 * 真实项目 ↔ packages/core/session
 *
 * ★ 核心原则: model-visible = logged
 *   模型看到的任何东西，都必须在日志里有记录。
 *   模型请求的历史消息，从日志派生（deriveMessages）。
 *   所以: 进程崩了可以重放恢复，可以 fork，可以审计。
 *
 * ★ 流式 chunk 也记录在日志里
 *   真实项目里每个 assistant/chunk 都追加到日志（保持 replay 保真度），
 *   最后组装成 assistant/message。deriveMessages 从 message 投影，不读 chunk。
 */

export class Session {
  constructor(id) {
    this.id = id ?? `sess_${Math.random().toString(36).slice(2, 8)}`
    this.events = []
    this.#seq = 0
  }

  #seq

  /**
   * 追加一条事件到日志。每条事件都是不可变事实（append-only）。
   * 真实项目: session.append('turn/start', { turn }) 等
   * @returns {seq, type, data} 追加的事件
   */
  append(type, data, opts = {}) {
    const event = { seq: this.#seq++, type, data, ...opts }
    this.events.push(event)
    return event
  }

  /**
   * ★ 从日志派生模型能看到的消息历史
   * 这是模型请求的核心数据来源——不是凭空构造的，是从日志投影出来的。
   * chunk 不参与投影——模型看到的是组装后的 assistant/message。
   */
  deriveMessages() {
    const messages = []
    for (const e of this.events) {
      switch (e.type) {
        case 'user/message':
          messages.push({ role: 'user', content: e.data.content })
          break
        case 'assistant/message':
          if (e.data.content) {
            messages.push({ role: 'assistant', content: e.data.content })
          }
          break
        case 'tool/call':
          messages.push({ role: 'assistant', tool_call: { name: e.data.name, args: e.data.args } })
          break
        case 'tool/result':
          messages.push({ role: 'tool', name: e.data.name, content: e.data.result })
          break
      }
    }
    return messages
  }

  /** 格式化打印日志（演示用，连续 chunk 折叠为一行） */
  printLog() {
    console.log('\n  ── Session 日志 ──')
    let i = 0
    while (i < this.events.length) {
      const e = this.events[i]

      // 折叠连续的 assistant/chunk
      if (e.type === 'assistant/chunk') {
        const seqs = [e.seq]
        const deltas = [e.data.chunk?.delta ?? '']
        let j = i + 1
        while (j < this.events.length && this.events[j].type === 'assistant/chunk') {
          seqs.push(this.events[j].seq)
          deltas.push(this.events[j].data.chunk?.delta ?? '')
          j++
        }
        const range = seqs.length > 1 ? `${seqs[0]}-${seqs.at(-1)}` : String(seqs[0])
        const assembled = deltas.join('')
        const kind = e.data.chunk?.kind ?? '?'
        console.log(`  ${range.padStart(4)} assistant/chunk     [${seqs.length} chunks, ${kind}] "${assembled.slice(0, 40)}..."`)
        i = j
        continue
      }

      // turn/end 显示原因
      if (e.type === 'turn/end') {
        const reason = e.data.reason?.kind ?? 'unknown'
        console.log(`  ${String(e.seq).padStart(4)} ${e.type.padEnd(20)} reason: ${reason}`)
        i++
        continue
      }

      const raw = e.data?.content ?? JSON.stringify(e.data)
      const detail = typeof raw === 'string' ? raw.slice(0, 55) : JSON.stringify(raw).slice(0, 55)
      console.log(`  ${String(e.seq).padStart(4)} ${e.type.padEnd(20)} ${detail}`)
      i++
    }
  }
}
