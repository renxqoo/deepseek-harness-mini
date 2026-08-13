/**
 * 前端 UI 插件化 — deepseek-harness-mini
 *
 * 真实项目 ↔ packages/client/ 下的前端插件体系
 *   - ConversationNodeDefinition  packages/client/runtime/.../conversation.ts
 *   - Slot Registry               packages/client/ui-slots/
 *   - ConversationViewDefinition  packages/client/runtime/.../conversation.ts
 *
 * ★ 前端跑在和后端同一套 Cordis 框架上 ★
 *   前端插件用 ctx.slots.register / ctx.conversationEvents.register 注册，
 *   和后端的 ctx.tools.register / ctx.systemPrompt.section 完全一样的模式。
 *
 * 三层注册点:
 *
 *   ① ConversationNodeDefinition — 事件 → UI 状态（数据层）
 *      match(event) → { id, role: 'start'|'update' } | null
 *      start / update → 纯函数式折叠状态
 *      buildViewNode(state) → 物化视图节点
 *
 *   ② ConversationView — 聚合多个节点的输出 → 可渲染快照
 *      从 session 日志重放事件，匹配 definition，折叠状态，输出有序节点列表
 *
 *   ③ Slot Registry — keyed 渲染器（渲染层）
 *      ctx.slots.register({ name, key }, renderer)
 *      每个 UI 状态 kind 对应一个渲染函数
 *      真实项目里 renderer 是 React 组件，这里用终端文本代替
 */

// ═══════════════════════════════════════════════════════════════
// 第 ③ 层: Slot Registry — keyed 渲染器注册表
// 对应真实项目: packages/client/ui-slots/ 的 ctx.slots
// ═══════════════════════════════════════════════════════════════

class SlotRegistry {
  /** slot名 → (key → renderer) */
  #slots = new Map()

  /**
   * 注册一个 keyed 渲染器
   * @param name - slot 名（如 'conversation.chat.node'）
   * @param key  - 节点 kind（如 'user-message', 'tool-call'）
   * @param renderer - (node) => void，输出渲染结果
   * @returns disposer
   */
  register({ name, key }, renderer) {
    let keyMap = this.#slots.get(name)
    if (!keyMap) {
      keyMap = new Map()
      this.#slots.set(name, keyMap)
    }
    keyMap.set(key, renderer)
    return () => keyMap.delete(key)
  }

  /** 查找一个渲染器 */
  get(name, key) {
    return this.#slots.get(name)?.get(key)
  }
}

// ═══════════════════════════════════════════════════════════════
// 第 ① 层: ConversationNodeDefinition 注册表
// 对应真实项目: ctx.conversationEvents.register(definition)
// ═══════════════════════════════════════════════════════════════

class ConversationEventRegistry {
  #definitions = []

  /**
   * 注册一个节点定义
   * 真实项目: ctx.conversationEvents.register(definition)，返回 disposer
   */
  register(definition) {
    this.#definitions.push(definition)
    return () => {
      const i = this.#definitions.indexOf(definition)
      if (i >= 0) this.#definitions.splice(i, 1)
    }
  }

  /** 获取所有定义 */
  definitions() {
    return [...this.#definitions]
  }
}

// ═══════════════════════════════════════════════════════════════
// 第 ② 层: ConversationView — 从 session 日志重放，渲染 UI
// 对应真实项目: packages/client/ui-conversation/ 的 chat-snapshot-builder
// ═══════════════════════════════════════════════════════════════

/**
 * 从 session 日志重放事件，匹配 ConversationNodeDefinition，
 * 折叠状态，用 Slot 渲染器输出终端文本。
 *
 * 这模拟了前端通过 WebSocket 接收事件流并渲染界面的过程。
 *
 * @param ctx     - Cordis Context（有 conversationEvents 和 slots）
 * @param session - Session 日志
 */
export function renderSession(ctx, session) {
  const eventRegistry = ctx.get('conversationEvents')
  const slots = ctx.get('slots')
  if (!eventRegistry || !slots) {
    console.log('  [ui] 前端插件未加载，跳过渲染')
    return
  }

  const defs = eventRegistry.definitions()

  // 重放事件，折叠节点状态
  const nodes = [] // 有序的 { def, state }
  const activeById = new Map() // id → nodes 中的索引

  for (const event of session.events) {
    for (const def of defs) {
      const match = def.match(event)
      if (!match) continue

      if (match.role === 'start') {
        const state = def.start(event.data, match)
        const entry = { def, state }
        nodes.push(entry)
        activeById.set(match.id, entry)
      } else if (match.role === 'update') {
        const entry = activeById.get(match.id)
        if (entry) {
          entry.state = entry.def.update(entry.state, event.data, match)
        }
      }
    }
  }

  // 物化视图节点
  const viewNodes = nodes
    .map(({ def, state }) => def.buildViewNode(state))
    .filter((n) => n !== null)

  // 渲染
  console.log('\n  ── UI 渲染（模拟前端界面）──\n')
  for (const node of viewNodes) {
    const renderer = slots.get('conversation.chat.node', node.kind)
    if (renderer) {
      renderer(node)
    } else {
      console.log(`  [未注册渲染器: ${node.kind}]`)
    }
  }
}

// ═══════════════════════════════════════════════════════════════
// 安装前端 UI 插件
// 对应真实项目: packages/client/ui-conversation/ 的 apply.ts
// ═══════════════════════════════════════════════════════════════

export function installClientUI(ctx) {
  ctx.plugin('client-ui', (api) => {
    // 注册两个服务
    const slots = new SlotRegistry()
    const conversationEvents = new ConversationEventRegistry()
    api.provide('slots', slots)
    api.provide('conversationEvents', conversationEvents)

    // ── 注册内置 ConversationNodeDefinition ──────────────

    // 用户消息节点
    api.effect(conversationEvents.register({
      kind: 'user-message',
      match(event) {
        if (event.type !== 'user/message') return null
        return { id: event.seq, role: 'start' }
      },
      start(data) {
        return { content: data.content }
      },
      buildViewNode(state) {
        return { kind: 'user-message', content: state.content }
      },
    }))

    // 助手消息节点
    api.effect(conversationEvents.register({
      kind: 'assistant-message',
      match(event) {
        if (event.type !== 'assistant/message') return null
        if (!event.data.content) return null // 跳过工具调用的 null 消息
        return { id: event.seq, role: 'start' }
      },
      start(data) {
        return { content: data.content }
      },
      buildViewNode(state) {
        return { kind: 'assistant-message', content: state.content }
      },
    }))

    // 工具调用节点（start: tool/call, update: tool/result）
    api.effect(conversationEvents.register({
      kind: 'tool-call',
      match(event) {
        if (event.type === 'tool/call') {
          return { id: `${event.data.turn}/${event.data.step}`, role: 'start' }
        }
        if (event.type === 'tool/result') {
          return { id: `${event.data.turn}/${event.data.step}`, role: 'update' }
        }
        return null
      },
      start(data) {
        return { name: data.name, args: data.args, result: null }
      },
      update(state, data) {
        return { ...state, result: data.result }
      },
      buildViewNode(state) {
        return { kind: 'tool-call', name: state.name, args: state.args, result: state.result }
      },
    }))

    // ── 注册 Slot 渲染器（终端文本代替 React 组件）─────────

    // 用户消息渲染器
    api.effect(slots.register(
      { name: 'conversation.chat.node', key: 'user-message' },
      (node) => {
        console.log(`  ┌─ 👤 用户 ${'─'.repeat(32)}┐`)
        console.log(`  │ ${node.content.slice(0, 48)}`)
        console.log(`  └${'─'.repeat(38)}┘`)
      },
    ))

    // 助手消息渲染器
    api.effect(slots.register(
      { name: 'conversation.chat.node', key: 'assistant-message' },
      (node) => {
        console.log(`  ┌─ 🤖 助手 ${'─'.repeat(32)}┐`)
        for (const line of node.content.split('\n').slice(0, 3)) {
          console.log(`  │ ${line.slice(0, 48)}`)
        }
        console.log(`  └${'─'.repeat(38)}┘`)
      },
    ))

    // 工具调用渲染器
    api.effect(slots.register(
      { name: 'conversation.chat.node', key: 'tool-call' },
      (node) => {
        console.log(`  ┌─ 🔧 ${node.name} ${'─'.repeat(31 - node.name.length)}┐`)
        console.log(`  │ 参数: ${JSON.stringify(node.args).slice(0, 42)}`)
        if (node.result) {
          console.log(`  │ 结果: ${String(node.result).slice(0, 42)}`)
        }
        console.log(`  └${'─'.repeat(38)}┘`)
      },
    ))
  })
}
