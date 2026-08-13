/**
 * list_files 工具插件
 *
 * 真实项目 ↔ packages/fs 里的文件工具
 *
 * 展示: 工具是插件。通过 ctx.tools.register() 注册，
 *       自动出现在模型可见的工具列表里（通过 tools↔system-prompt 缝合点）。
 *
 * ★ 工具自带 UI 展示意（Tool Presentation）
 *   presentCall / presentResult 是 args 的纯函数，
 *   后端发送 tool/call 事件时调用，把 view 附在事件里推给前端。
 *   前端根据 view 类型选择渲染组件，不需要 special-case 工具名。
 */

export function installListFiles(ctx) {
  ctx.plugin('list-files', (api) => {
    const tools = api.get('tools')

    const dispose = tools.register({
      name: 'list_files',
      description: '列出指定目录下的文件',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '目录路径' },
        },
      },
      async execute(args) {
        // 模拟文件系统（真实项目通过 ctx.fs 读真实目录）
        return JSON.stringify(['a.ts', 'b.ts', 'README.md'])
      },

      // ★ UI 展示意 — 纯函数，决定工具在界面上怎么显示
      // 真实项目: packages/core/tools/src/presentation.ts 的 ToolCallView
      presentCall(args) {
        return { card: 'generic', title: 'list_files', detail: `路径: ${args.path}` }
      },
      presentResult(args, { result }) {
        return { card: 'generic', title: 'list_files', detail: result }
      },
    })

    api.effect(dispose)
  })
}
