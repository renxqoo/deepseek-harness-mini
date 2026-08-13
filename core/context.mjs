/**
 * Context — Cordis 极简版，deepseek-harness 的插件框架核心
 *
 * 真实项目 ↔ vendor/ 下的 Cordis 源码
 *
 * 一切都是插件。插件通过注册"服务""效果""事件监听器"来扩展系统。
 *
 * ★ 三种事件分发（理解整个架构的关键）:
 *
 *   emit      通知: 所有监听器都调，异常隔离，不阻塞
 *             真实用途 → 日志、审计、UI 更新
 *
 *   serial    串行: 按顺序执行，某个返回非 undefined 则终止后续
 *             真实用途 → agent/turn-stopping（决定是否提前结束）
 *
 *   waterfall 瀑布: 洋葱模型，每个监听器包裹 next()
 *             handler(payload, next) → 调 next() 继续，不调 = 拦截
 *             真实用途 → agent/pre-step, agent/request, tools/*
 */

export class Context {
  #services = {}
  #listeners = {}
  #disposers = []

  /** 注册服务到 ctx（ctx.tools, ctx.systemPrompt, ctx.llm ...） */
  provide(key, service) {
    this.#services[key] = service
  }

  /** 获取已注册的服务 */
  get(key) {
    return this.#services[key]
  }

  /**
   * 安装一个插件。插件通过 api 注册效果和事件监听器。
   * 真实 Cordis: ctx.plugin(interfaces) → apply(ctx)
   */
  plugin(name, install) {
    const api = {
      /** ★ 注册可撤销效果，返回 disposer */
      effect: (dispose, tag = name) => {
        const entry = { tag, dispose }
        this.#disposers.push(entry)
        return () => {
          const i = this.#disposers.indexOf(entry)
          if (i >= 0) {
            this.#disposers.splice(i, 1)
            dispose?.()
          }
        }
      },
      provide: (key, service) => this.provide(key, service),
      get: (key) => this.get(key),

      /** 注册 emit 监听器（只观察） */
      on: (eventName, handler) => this.#addListener(eventName, 'emit', handler),
      /** 注册 serial 监听器（可终止） */
      serial: (eventName, handler) => this.#addListener(eventName, 'serial', handler),
      /** 注册 waterfall 监听器（洋葱包裹，可拦截） */
      waterfall: (eventName, handler) => this.#addListener(eventName, 'waterfall', handler),

      /** 分发 emit 事件（转发到 ctx） */
      emit: (eventName, payload) => this.emit(eventName, payload),
    }
    install(api)
    return api
  }

  #addListener(eventName, kind, handler) {
    const entry = { kind, handler }
    ;(this.#listeners[eventName] ??= []).push(entry)
    return () => {
      const arr = this.#listeners[eventName]
      const i = arr.indexOf(entry)
      if (i >= 0) arr.splice(i, 1)
    }
  }

  /** emit: 通知所有匹配监听器，异常隔离，不阻塞 */
  emit(eventName, payload) {
    for (const { kind, handler } of this.#listeners[eventName] ?? []) {
      if (kind !== 'emit') continue
      try {
        handler(payload)
      } catch (e) {
        console.error(`[emit ${eventName}] 监听器出错:`, e.message)
      }
    }
  }

  /** serial: 串行执行，返回首个非 undefined 结果 */
  async serial(eventName, payload) {
    for (const { kind, handler } of this.#listeners[eventName] ?? []) {
      if (kind !== 'serial') continue
      const result = await handler(payload)
      if (result !== undefined) return result
    }
    return undefined
  }

  /**
   * waterfall: 洋葱模型，逐层包裹 next()
   *   chain = [handler1, handler2, ..., defaultFn]
   *   每个 handler(payload, next) → 调 next() 传给下一层，不调 = 拦截
   */
  async waterfall(eventName, payload, defaultFn) {
    const handlers = (this.#listeners[eventName] ?? [])
      .filter((l) => l.kind === 'waterfall')
      .map((l) => l.handler)
    const chain = [...handlers, defaultFn]
    let index = 0
    const next = async (p) => {
      const fn = chain[index++]
      if (index >= chain.length) return fn(p)
      return fn(p, next)
    }
    return next(payload)
  }

  /** 销毁所有插件效果 */
  async dispose() {
    for (const { dispose } of this.#disposers.reverse()) {
      try {
        await dispose?.()
      } catch {
        /* 清理出错也继续 */
      }
    }
    this.#disposers = []
    this.#listeners = {}
  }
}
