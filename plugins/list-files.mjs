/**
 * list_files 工具插件
 *
 * 真实项目 ↔ packages/fs 里的文件工具
 *
 * 展示: 工具是插件。通过 ctx.tools.register() 注册，
 *       自动出现在模型可见的工具列表里（通过 tools↔system-prompt 缝合点）。
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
    })

    // 注册为可撤销效果（插件卸载时工具自动移除）
    api.effect(dispose)
  })
}
