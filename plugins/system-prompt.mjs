/**
 * System Prompt 组装器
 *
 * 真实项目 ↔ packages/core/system-prompt
 *
 * 设计:
 *   - 插件通过 section() 注册 prompt 片段（带 order 排序）
 *   - 工具 schema 通过 tools(provider) 注入（这是 tools 包的缝合点）
 *   - assemble() 收集所有 section + 工具 schema，按 order 排序
 *
 * ★ section 按 order 排序（真实项目的约定）:
 *     -100 = harness 身份提示
 *        0 = 人格/角色
 *    100+ = 工具使用指导
 */

export function installSystemPrompt(ctx) {
  ctx.plugin('system-prompt', (api) => {
    const sections = []
    const toolProviders = []

    api.provide('systemPrompt', {
      /**
       * 注册一段 prompt section
       * @param name   - 唯一标识
       * @param order  - 排序权重（小的在前）
       * @param text   - 静态字符串 或 (ctx) => string 动态生成
       * @returns disposer
       */
      section({ name, order, text }) {
        const entry = { name, order, text }
        sections.push(entry)
        api.emit('system-prompt/change', { name })
        return () => {
          const i = sections.indexOf(entry)
          if (i >= 0) sections.splice(i, 1)
        }
      },

      /**
       * ★ 缝合点: 注册工具 schema provider
       * tools.mjs 初始化时调用这个，把自己注册为一个 provider。
       * assemble() 时所有 provider 的输出被收集，注入到 prompt assembly。
       * 真实项目: ToolRuntime 构造时调 ctx.systemPrompt.tools(context => this.wireSchemas(...))
       */
      tools(provider) {
        toolProviders.push(provider)
        return () => {
          const i = toolProviders.indexOf(provider)
          if (i >= 0) toolProviders.splice(i, 1)
        }
      },

      /**
       * 组装最终的 prompt assembly
       * 1. 收集 sections，按 order 升序排序
       * 2. 求值动态文本（text 是函数时调用它）
       * 3. 收集工具 schema（通过所有 tool provider）
       */
      assemble() {
        const sorted = [...sections].sort((a, b) => a.order - b.order)
        const resolved = sorted.map((s) => ({
          name: s.name,
          text: typeof s.text === 'function' ? s.text({}) : s.text,
        }))
        const toolSchemas = toolProviders.flatMap((p) => p() ?? [])
        return { sections: resolved, tools: toolSchemas }
      },
    })
  })
}
