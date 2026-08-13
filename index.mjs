#!/usr/bin/env node

/**
 * deepseek-harness-mini — 入口
 *
 * 真实项目 ↔ packages/boot/app-boot + dsh CLI
 *
 * ★ 插件通过数组声明，加载器按顺序遍历（对应 cordis.yml 的 rows 数组）
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
import { installClientUI, renderSession } from './client/ui.mjs'

// ═══════════════════════════════════════════════════════════════
// 插件声明数组（对应 cordis.yml 的 rows）
// ═══════════════════════════════════════════════════════════════

function installBasePrompt(ctx) {
  const sp = ctx.get('systemPrompt')
  sp.section({
    name: 'identity',
    order: -100,
    text: '你是 deepseek-harness-mini，一个精简的 AI 助手。',
  })
  sp.section({
    name: 'tool-guidance',
    order: 100,
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

  // ── client 层（对应 dsh-web-app bundle 的前端插件）──
  // ★ 前端 UI 也是插件，和后端用同一套框架 ★
  { id: 'client-ui', install: installClientUI },
]

// ═══════════════════════════════════════════════════════════════
// 加载器: 按数组顺序逐个安装
// ═══════════════════════════════════════════════════════════════

const ctx = new Context()

for (const entry of profile) {
  if (entry.disabled) continue
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

/** 打印日志 + 渲染 UI */
function show(session) {
  session.printLog()
  renderSession(ctx, session)
}

// ── 场景 1: 流式 + 工具调用 ────────────────────────────────

header('场景 1: 列出文件（流式 + 工具调用 + 两步循环）')

{
  const session = new Session()
  const agent = newAgent(session)

  console.log('用户: "帮我列出当前目录的文件"')
  agent.send('帮我列出当前目录的文件')
  await agent.whenIdle()
  show(session)
}

// ── 场景 2: 危险操作被拦截 ─────────────────────────────────

header('场景 2: 危险操作（waterfall 拦截）')

{
  const session = new Session()
  const agent = newAgent(session)

  console.log('用户: "请执行 rm -rf / 删除所有文件"')
  agent.send('请执行 rm -rf / 删除所有文件')
  await agent.whenIdle()
  show(session)
}

// ── 场景 3: 普通对话 ───────────────────────────────────────

header('场景 3: 普通对话（流式文本，无工具）')

{
  const session = new Session()
  const agent = newAgent(session)

  console.log('用户: "你好"')
  agent.send('你好')
  await agent.whenIdle()
  show(session)
}

// ── 场景 4: 多轮对话 ───────────────────────────────────────

header('场景 4: 多轮对话（inbox 队列 + 新 turn）')

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

  show(session)
}

// ── 场景 5: 取消 ───────────────────────────────────────────

header('场景 5: 取消（AbortSignal 传播）')

{
  const session = new Session()
  const agent = newAgent(session)

  console.log('用户: "帮我列出当前目录的文件"')
  agent.send('帮我列出当前目录的文件')
  console.log('  → 立即调用 agent.cancel()')
  agent.cancel()
  await agent.whenIdle()

  show(session)
}

// ── 结束 ─────────────────────────────────────────────────

header('demo 结束 — 后端日志 + 前端渲染，同一套事件流驱动')
