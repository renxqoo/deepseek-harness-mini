#!/usr/bin/env node

/**
 * deepseek-harness-mini — 入口
 *
 * 真实项目 ↔ packages/boot/app-boot + dsh CLI
 *
 * ★ 插件通过数组声明，加载器按顺序遍历（对应 cordis.yml 的 rows 数组）
 *
 * 真实项目的 cordis.yml 长这样:
 *
 *   - id: system-prompt
 *     name: '@deepseek-ai/dsh-system-prompt'
 *   - id: tools
 *     name: '@deepseek-ai/dsh-tools'
 *   - id: llm-deepseek
 *     name: '@deepseek-ai/dsh-llm-deepseek'
 *     config:
 *       thinking: enabled
 *
 * 这里的 profile 数组就是它的精简版:
 *   id     ↔ 行标识（后续层可按 id 覆盖）
 *   install ↔ name（要执行的插件安装函数）
 *   config  ↔ config（传给插件的配置）
 *
 * 运行: node index.mjs   （Node 18+，零依赖）
 */

import { Context } from './core/context.mjs'
import { Session } from './core/session.mjs'
import { AgentLoopService } from './core/agent-loop.mjs'

import { installSystemPrompt } from './plugins/system-prompt.mjs'
import { installTools } from './plugins/tools.mjs'
import { installLlm } from './plugins/llm.mjs'
import { installListFiles } from './plugins/list-files.mjs'
import { installSafety } from './plugins/safety.mjs'

// ═══════════════════════════════════════════════════════════════
// 插件声明数组（对应 cordis.yml 的 rows）
// ═══════════════════════════════════════════════════════════════

/**
 * base-prompt: 注册 prompt section（对应 dsh-base bundle 里的身份提示）
 * 真实项目里 prompt section 由各个插件自己注册，这里简化为内联
 */
function installBasePrompt(ctx) {
  const sp = ctx.get('systemPrompt')
  sp.section({
    name: 'identity',
    order: -100, // 最先（harness 身份）
    text: '你是 deepseek-harness-mini，一个精简的 AI 助手。',
  })
  sp.section({
    name: 'tool-guidance',
    order: 100, // 靠后（工具使用指导）
    text: '你可以使用工具来帮助用户完成任务。需要时直接调用，不要犹豫。',
  })
}

/** agent-loop: ★ 本身也是一个插件 ★ */
function installAgentLoop(ctx) {
  ctx.provide('agentLoop', new AgentLoopService(ctx))
}

const profile = [
  // ── base 层（对应 dsh-base bundle）──────────────────
  { id: 'system-prompt', install: installSystemPrompt },
  { id: 'tools', install: installTools },
  { id: 'llm', install: installLlm },
  { id: 'list-files', install: installListFiles },
  { id: 'base-prompt', install: installBasePrompt },

  // ── guard 层（对应 dsh-guard bundle）────────────────
  { id: 'safety', install: installSafety },

  // ── core 层（agent-loop 本身也是插件）────────────────
  { id: 'agent-loop', install: installAgentLoop },
]

// ═══════════════════════════════════════════════════════════════
// 加载器: 按数组顺序逐个安装
// 对应 app-boot 的 composeEntries() + Loader 遍历 entries
// ═══════════════════════════════════════════════════════════════

const ctx = new Context()

for (const entry of profile) {
  if (entry.disabled) continue // 条件禁用（对应 cordis.yml 的 disabled: !!js ...）
  entry.install(ctx, entry.config)
}

// ═══════════════════════════════════════════════════════════════
// 场景
// ═══════════════════════════════════════════════════════════════

function header(title) {
  console.log('\n' + '━'.repeat(60))
  console.log(title)
  console.log('━'.repeat(60))
}

function newAgent(session) {
  return ctx.get('agentLoop').create(session, { provider: 'mock', model: 'mock-model' })
}

// ── 场景 1: 流式 + 工具调用（两步 ReAct 循环）──────────────

header('场景 1: 列出文件（① 流式输出 + 工具调用 + 两步循环）')

{
  const session = new Session()
  const agent = newAgent(session)

  console.log('用户: "帮我列出当前目录的文件"')
  agent.send('帮我列出当前目录的文件')
  await agent.whenIdle()
  session.printLog()
}

// ── 场景 2: 危险操作被 safety 插件拦截 ──────────────────────

header('场景 2: 危险操作（waterfall 拦截 — 不调 next()）')

{
  const session = new Session()
  const agent = newAgent(session)

  console.log('用户: "请执行 rm -rf / 删除所有文件"')
  agent.send('请执行 rm -rf / 删除所有文件')
  await agent.whenIdle()
  session.printLog()
}

// ── 场景 3: 普通对话（流式文本）──────────────────────────

header('场景 3: 普通对话（① 流式文本，无工具调用）')

{
  const session = new Session()
  const agent = newAgent(session)

  console.log('用户: "你好"')
  agent.send('你好')
  await agent.whenIdle()
  session.printLog()
}

// ── 场景 4: 多轮对话 ──────────────────────────────────────

header('场景 4: 多轮对话（② inbox 队列 + 自动开始新 turn）')

{
  const session = new Session()
  const agent = newAgent(session)

  console.log('用户: "帮我列出当前目录的文件"')
  agent.send('帮我列出当前目录的文件')
  await agent.whenIdle()

  console.log('\n  （第一轮结束后，用户又发了一条消息）')
  console.log('用户: "你好"')
  agent.send('你好')
  await agent.whenIdle()

  session.printLog()
  console.log('\n  ↑ 注意: 两个 turn/start + 两个 turn/end = 两轮独立对话')
}

// ── 场景 5: 取消传播 ──────────────────────────────────────

header('场景 5: 取消（③ AbortSignal 传播 — turn 被中断）')

{
  const session = new Session()
  const agent = newAgent(session)

  console.log('用户: "帮我列出当前目录的文件"')
  agent.send('帮我列出当前目录的文件')
  console.log('  → 立即调用 agent.cancel()')
  agent.cancel()
  await agent.whenIdle()

  session.printLog()
  console.log('\n  ↑ 注意: turn/end reason = aborted，没有任何 step 或 chunk')
}

// ── 结束 ─────────────────────────────────────────────────

header('demo 结束 — 5 个场景覆盖了完整的 agent 工作流程')
