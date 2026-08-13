/**
 * Mock LLM 适配器（流式）
 *
 * 真实项目 ↔ packages/llm/llm-deepseek
 *
 * ★ 流式输出: stream() 是一个 async generator，逐 chunk 产出
 *   真实项目: 每个 chunk 是 SSE delta（文本片段或工具调用片段）
 *   这里: 文本按字符分段产出，工具调用一次性产出
 *
 * ★ signal 传播: stream 接收 AbortSignal，可以在生成过程中被取消
 *
 * 替换: 写另一个 installDeepSeekLlm(ctx) 注册到 ctx.llm 即可，
 *       agent-loop 和其他插件完全不需要改动——这就是插件化的意义。
 */

export function installLlm(ctx) {
  ctx.plugin('llm', (api) => {
    api.provide('llm', {
      /**
       * ★ 流式模型调用 — async generator
       * @param request - { system, messages, tools }
       * @param signal  - AbortSignal（用户取消时 abort）
       * @yields {{ kind: 'text', delta: string } | { kind: 'tool_call', tool: string, args: object }}
       */
      async *stream(request, signal) {
        const decision = decide(request)

        if (decision.type === 'text') {
          // 逐字符流式产出文本（真实项目按 token 流）
          for (const ch of decision.content) {
            if (signal?.aborted) return
            yield { kind: 'text', delta: ch }
          }
        } else {
          // 工具调用（简化: 一次性产出完整调用）
          if (signal?.aborted) return
          yield { kind: 'tool_call', tool: decision.tool, args: decision.args }
        }
      },
    })
  })
}

/** 模拟模型的决策逻辑 */
function decide(request) {
  const messages = request.messages
  const last = messages.at(-1)

  // 规则 1: 如果上一步是工具结果 → 模型总结回复
  // （这就是 ReAct 循环的最后一步: 工具结果喂回模型，模型给出最终答案）
  if (last?.role === 'tool') {
    return {
      type: 'text',
      content: `根据查询结果: ${last.content}\n以上就是当前目录的内容。`,
    }
  }

  // 规则 2: 用户提到"文件" → 模型决定调 list_files 工具
  if (last?.content?.includes('文件') || last?.content?.toLowerCase().includes('file')) {
    const hasTool = request.tools?.some((t) => t.name === 'list_files')
    if (hasTool) {
      return {
        type: 'tool_call',
        tool: 'list_files',
        args: { path: '.' },
      }
    }
  }

  // 规则 3: 默认文本回复
  return {
    type: 'text',
    content: `我收到你说的是: "${last?.content ?? ''}"`,
  }
}
