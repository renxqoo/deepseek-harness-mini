/**
 * Agent Loop — deepseek-harness 的心脏
 *
 * 真实项目 ↔ packages/core/agent-loop (ReactLoopAgent)
 *
 * ★ 这本身也是一个插件 ★
 *   通过 ctx.provide('agentLoop', ...) 注册，和 system-prompt、tools、llm
 *   没有本质区别。你可以写一个完全不同的 driver 替换它。
 *
 * 核心循环:
 *
 *   kick → turn → step → (工具调用?) → step → ... → turn 结束
 *                                        ↑
 *                                   inbox 有新消息? → 新 turn
 *
 * 四个核心机制（与真实项目对齐）:
 *
 *   ① 流式输出   llm.stream() 是 async generator，逐 chunk 产出
 *                每个 chunk 追加到 session 日志，最后组装成 assistant/message
 *
 *   ② Inbox      两种消息目标:
 *                next-turn → 开始新一轮对话
 *                next-step → 注入当前对话的下一步（steer）
 *
 *   ③ 取消传播   每个 turn 有自己的 AbortController
 *                signal 传到 LLM stream 和工具执行
 *                每个扩展点检查 signal.throwIfAborted()
 *
 *   ④ Phase      idle ↔ running 状态机
 *                running 时新消息排队（latch），不重复启动驱动
 *
 * 扩展点（★标记）:
 *   ★ agent/pre-step      (waterfall) 改写消息 / 注入上下文 / 拒绝
 *   ★ agent/request       (waterfall) 改模型请求参数
 *   ★ agent/turn-stopping (serial)   决定是否提前结束
 */

/**
 * Agent Loop 服务（注册到 ctx.agentLoop）
 */
export class AgentLoopService {
  constructor(ctx) {
    this.ctx = ctx
  }

  create(session, options = {}) {
    return new Agent(this.ctx, session, options)
  }
}

// ═══════════════════════════════════════════════════════════════
// Inbox — 消息队列，区分 next-turn 和 next-step
// 真实项目 ↔ packages/core/agent/src/inbox.ts
// ═══════════════════════════════════════════════════════════════

class Inbox {
  #nextTurn = []
  #nextStep = []

  get hasNextTurn() {
    return this.#nextTurn.length > 0
  }
  get hasNextStep() {
    return this.#nextStep.length > 0
  }
  get hasPending() {
    return this.hasNextTurn || this.hasNextStep
  }

  splice(target, message) {
    if (target === 'next-turn') this.#nextTurn.push(message)
    else this.#nextStep.push(message)
  }

  claimNextTurn() {
    const msgs = this.#nextTurn
    this.#nextTurn = []
    return msgs
  }

  claimNextStep() {
    const msgs = this.#nextStep
    this.#nextStep = []
    return msgs
  }

  clear() {
    this.#nextTurn = []
    this.#nextStep = []
  }
}

// ═══════════════════════════════════════════════════════════════
// StreamAssembler — 把流式 chunk 组装成完整回复
// 真实项目 ↔ packages/llm/llm 的 BlockAssembler
// ═══════════════════════════════════════════════════════════════

class StreamAssembler {
  #text = ''
  #toolCall = null

  push(chunk) {
    if (chunk.kind === 'text') this.#text += chunk.delta
    else if (chunk.kind === 'tool_call') this.#toolCall = { tool: chunk.tool, args: chunk.args }
  }

  /** 流结束后返回组装结果 */
  finish() {
    if (this.#toolCall) return { kind: 'tool_call', ...this.#toolCall }
    return { kind: 'text', content: this.#text }
  }
}

// ═══════════════════════════════════════════════════════════════
// Agent — 驱动一个 session 走过 turn 和 step 边界
// 真实项目 ↔ class ReactLoopAgent implements Agent
// ═══════════════════════════════════════════════════════════════

class Agent {
  /** ④ Phase: idle ↔ running */
  #phase = 'idle'
  #abort = null
  #activity = Promise.resolve()

  /** ② Inbox */
  #inbox = new Inbox()

  constructor(ctx, session, options) {
    this.ctx = ctx
    this.session = session
    this.options = options
  }

  get status() {
    return this.#phase
  }

  // ── 公共 API ──────────────────────────────────────────

  /**
   * ② 发送消息（fire-and-forget）。消息进 inbox，唤醒驱动。
   * @param target 'next-turn' 开始新对话轮；'next-step' 注入当前轮的下一步
   */
  send(content, target = 'next-turn') {
    this.#inbox.splice(target, { content })
    this.#wake()
  }

  /** ② steer: 向当前对话注入一条消息（不开始新 turn） */
  steer(content) {
    this.#inbox.splice('next-step', { content })
    this.#wake()
  }

  /** ③ 取消: 清空 inbox + abort 当前 turn 的 signal */
  cancel(cause = { kind: 'cancelled' }) {
    this.#inbox.clear()
    if (this.#phase === 'running') this.#abort?.abort(cause)
  }

  /** 等待 agent 完成所有工作 */
  async whenIdle() {
    await this.#activity
  }

  // ── ④ Phase 管理 ─────────────────────────────────────

  /**
   * 唤醒驱动。如果已经在 running，消息会在 inbox 里等当前 turn 结束后被拾取。
   * 真实项目: wakeDriver() + wakeRequested latch 机制
   */
  #wake() {
    if (this.#phase !== 'idle') return // 已在运行，latch
    if (!this.#inbox.hasPending) return
    this.#phase = 'running'
    this.#abort = new AbortController()
    const signal = this.#abort.signal
    this.#activity = this.#kick(signal).finally(() => {
      this.#phase = 'idle'
      // 驱动结束后检查是否有新消息排队
      if (this.#inbox.hasPending) this.#wake()
    })
  }

  // ── 主循环 ───────────────────────────────────────────

  /** ① 循环入口: 反复执行 turn 直到 inbox 清空 */
  async #kick(signal) {
    try {
      while (await this.#turn(signal)) {}
    } catch (e) {
      // 取消错误在 turn 内部已处理，这里静默
      if (!signal.aborted) throw e
    }
  }

  /**
   * 一轮对话 (turn)
   * turn = 零或多个 step
   * ② turn 结束后检查 inbox 是否有 next-turn 消息 → 决定是否开始新 turn
   */
  async #turn(signal) {
    const turn = this.#countTurns() + 1
    let turnEnd = null

    try {
      this.session.append('turn/start', { turn })
    } catch (e) {
      this.session.append('turn/end', { turn, reason: { kind: 'error', message: e.message } })
      throw e
    }

    let step = 0
    let target = 'next-turn'

    try {
      while (true) {
        // ③ 每个关键位置检查取消
        signal.throwIfAborted()
        step++

        // ② 从 inbox 取消息
        const claimed = target === 'next-turn' ? this.#inbox.claimNextTurn() : this.#inbox.claimNextStep()

        // 追加到 session 日志
        for (const msg of claimed) {
          this.session.append('user/message', { content: msg.content })
        }

        // ★ preStep (waterfall)
        const decision = await this.#preStep(turn, step, signal)

        if (decision.kind === 'reject') {
          turnEnd = { kind: 'blocked' }
          break
        }

        // 第一步没有任何消息 → 空 turn，不调模型
        if (step === 1 && claimed.length === 0) {
          turnEnd = { kind: 'completed' }
          break
        }

        // 执行 step
        this.session.append('step/start', { turn, step })
        const result = await this.#step(turn, step, decision, signal)
        this.session.append('step/end', { turn, step })

        // ③ 取消
        if (result.aborted) {
          turnEnd = { kind: 'aborted', reason: signal.reason }
          break
        }

        // ② 检查 next-step 消息（steer 注入）
        if (this.#inbox.hasNextStep) {
          target = 'next-step'
          continue
        }

        if (!result.continue) {
          // ★ agent/turn-stopping (serial)
          const stop = await this.ctx.serial('agent/turn-stopping', { turn, step })
          turnEnd = stop === true ? { kind: 'stopped' } : result.endReason ?? { kind: 'completed' }
          break
        }

        target = 'next-step'
      }
    } catch (e) {
      // ③ 取消或错误
      if (signal.aborted) {
        turnEnd = { kind: 'aborted', reason: signal.reason }
      } else {
        turnEnd = { kind: 'error', message: e.message }
      }
    } finally {
      this.session.append('turn/end', { turn, reason: turnEnd })
    }

    // ② turn 结束后: inbox 有 next-turn 消息 → 开始新 turn
    return this.#inbox.hasNextTurn
  }

  /** ★ agent/pre-step: 组装 prompt + 插件可改写/拒绝 */
  async #preStep(turn, step, signal) {
    const tools = this.ctx.get('tools')
    const systemPrompt = this.ctx.get('systemPrompt')

    const assembly = systemPrompt.assemble()
    const system = assembly.sections.map((s) => s.text).join('\n\n')
    const messages = this.session.deriveMessages()

    signal.throwIfAborted()

    const decision = await this.ctx.waterfall(
      'agent/pre-step',
      { messages, system, turn, step, signal },
      (p) => ({ kind: 'enter', messages: p.messages, system: p.system }),
    )
    signal.throwIfAborted()
    return decision
  }

  /**
   * 一步 (step) = 一次模型请求 + 可能的工具调用
   * ① 流式: 逐 chunk 消费 → 追加日志 → 组装
   * ③ signal: 传到 LLM 和工具
   */
  async #step(turn, step, decision, signal) {
    const tools = this.ctx.get('tools')
    const llm = this.ctx.get('llm')

    // ★ agent/request (waterfall)
    const request = await this.ctx.waterfall(
      'agent/request',
      { turn, step, signal },
      () => ({
        provider: this.options.provider ?? 'mock',
        model: this.options.model ?? 'mock-model',
        system: decision.system,
        messages: decision.messages,
        tools: tools.schemas(),
      }),
    )
    signal.throwIfAborted()

    // ── ① 流式消费 LLM ──────────────────────────────────
    const assembler = new StreamAssembler()
    const chunkSeqs = []

    console.log(`  [Turn ${turn} Step ${step}] 调用 ${request.model}（流式）...`)

    for await (const chunk of llm.stream(request, signal)) {
      signal.throwIfAborted()
      const event = this.session.append('assistant/chunk', { turn, step, chunk })
      chunkSeqs.push(event.seq)
      assembler.push(chunk)
    }
    signal.throwIfAborted()

    const finish = assembler.finish()

    // 组装后的完整消息追加到日志，关联源 chunk
    this.session.append('assistant/message', {
      turn,
      step,
      content: finish.kind === 'text' ? finish.content : null,
    }, { sourceEventSeqs: chunkSeqs })

    // ── 处理工具调用 ─────────────────────────────────────
    if (finish.kind === 'tool_call') {
      // 先记录工具调用请求（模型决定调什么）
      this.session.append('tool/call', { name: finish.tool, args: finish.args, turn, step })
      console.log(`  [Turn ${turn} Step ${step}] → 模型调用工具: ${finish.tool}`)

      // ③ signal 传到工具执行
      const result = await tools.execute(finish.tool, finish.args, { turn, step, signal })
      this.session.append('tool/result', { name: finish.tool, result, turn, step })
      console.log(`  [Turn ${turn} Step ${step}] ← 工具返回: ${String(result).slice(0, 55)}`)

      return { continue: true } // 把工具结果喂回模型
    }

    console.log(`  [Turn ${turn} Step ${step}] ✓ 模型回复: ${finish.content.slice(0, 55)}...`)
    return { continue: false, endReason: { kind: 'completed' } }
  }

  #countTurns() {
    return this.session.events.filter((e) => e.type === 'turn/start').length
  }
}
