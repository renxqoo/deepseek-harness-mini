/**
 * 安全审查插件
 *
 * 真实项目 ↔ packages/guard (loop-hygiene)
 *
 * 展示: 通过 agent/pre-step waterfall 介入循环
 *
 * ★ waterfall 拦截模式:
 *   handler(payload, next) →
 *     安全 → return next(payload)   // 调 next() 继续传递
 *     危险 → return { kind: 'reject' }  // 不调 next() = 拦截，整个 step 被跳过
 */

export function installSafety(ctx) {
  ctx.plugin('safety', (api) => {
    const DANGEROUS = ['rm -rf', 'delete from', 'drop table', 'format c']

    api.waterfall('agent/pre-step', (payload, next) => {
      // 检查最后一条用户消息
      const lastUser = payload.messages.filter((m) => m.role === 'user').at(-1)
      const content = (lastUser?.content ?? '').toLowerCase()

      if (DANGEROUS.some((d) => content.includes(d))) {
        console.log('  ⛔ [safety] 检测到危险操作，拒绝执行（不调 next()）')
        // ★ 不调 next()，直接返回 reject → waterfall 链终止
        return { kind: 'reject' }
      }

      // 安全 → 继续传递给下一个 waterfall 监听器（或默认行为）
      return next(payload)
    })
  })
}
