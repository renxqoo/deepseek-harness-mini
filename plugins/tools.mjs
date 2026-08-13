/**
 * 工具注册表 + 三段式执行管道
 *
 * 真实项目 ↔ packages/core/tools
 *
 * ★ 三个核心设计:
 *
 * 1. 缝合点 — 初始化时调 ctx.systemPrompt.tools(provider)
 *    把工具 schema 注入 prompt assembly，模型就能看到工具列表
 *
 * 2. 白名单投影 — schemas() 只暴露 name/description/parameters
 *    execute / output / timeout 等执行细节绝不发给模型
 *
 * 3. 三段式管道 — execute() 走三个 waterfall:
 *    tools/pre-execute  → allow / deny(reason)    守卫: 可拒绝
 *    执行工具 body
 *    tools/post-execute → accept / block(reason)  后处理: 可拦截结果
 */

export function installTools(ctx) {
  ctx.plugin('tools', (api) => {
    const registry = new Map()

    const service = {
      /**
       * 注册一个工具
       * 真实项目: ctx.tools.register(defineTool({ name, description, ... }))
       * @returns disposer（卸载时移除工具）
       */
      register(definition) {
        registry.set(definition.name, definition)
        api.emit('tools/change', { name: definition.name })
        return () => registry.delete(definition.name)
      },

      /**
       * ★ 白名单投影: 只暴露模型需要看到的字段
       * execute / output / timeout / presentation 等绝不发给模型
       * 真实项目: schemaOf() 只投影 name / description / parameters
       */
      schemas() {
        return [...registry.values()].map((t) => ({
          name: t.name,
          description: t.description,
          parameters: t.parameters,
        }))
      },

      /**
       * ★ 三段式执行管道
       *
       * 真实项目: tools/pre-execute → execute → tools/post-execute
       * 每段都是 waterfall，插件可以介入:
       *   pre-execute: 审批/守卫 → allow 或 deny
       *   execute:     真正调用工具
       *   post-execute: 校验/拦截结果 → accept 或 block
       */
      async execute(name, args, execCtx = {}) {
        const tool = registry.get(name)
        if (!tool) throw new Error(`未知工具: ${name}`)

        // ── 第 1 段: pre-execute (waterfall) ──
        const pre = await ctx.waterfall(
          'tools/pre-execute',
          { tool: name, args, ...execCtx },
          () => ({ kind: 'allow' }),
        )
        if (pre.kind === 'deny') {
          throw new Error(`工具 ${name} 被拒绝: ${pre.reason}`)
        }

        // ── 第 2 段: 执行工具 body ──
        const rawResult = await tool.execute(args, execCtx)

        // ── 第 3 段: post-execute (waterfall) ──
        const post = await ctx.waterfall(
          'tools/post-execute',
          { tool: name, args, result: rawResult, ...execCtx },
          () => ({ kind: 'accept', result: rawResult }),
        )
        if (post.kind === 'block') {
          throw new Error(`工具 ${name} 结果被拦截: ${post.reason}`)
        }

        return post.result
      },
    }

    api.provide('tools', service)

    // ★ 缝合点: 把工具 schema 注入 system prompt
    // 真实项目: ToolRuntime 构造时自动调 ctx.systemPrompt.tools(provider)
    const systemPrompt = api.get('systemPrompt')
    if (systemPrompt) {
      systemPrompt.tools(() => service.schemas())
    }
  })
}
