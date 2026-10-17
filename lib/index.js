export const name = 'dsh-tool-governor'
// 0.2.x：agent 不再是根服务（改为 agents 注册表 + 按 agent 路由的 scope 事件）。
// 只注入 tools；每个钩子从 exec.agent / event.agent 取当前 agent。
export const inject = ['tools']

const DEFAULTS = {
  maxToolCallsPerTurn: 24,
  maxStepsPerTurn: 16,
  repeatThreshold: 2,
  consecutiveFailureThreshold: 2,
  denyTools: [],
  denyMessage:
    '此调用已被工具治理插件拦截。请立即基于已有信息给出结论，不要再尝试相同或类似的工具调用。',
}

function globToRegex(glob) {
  const escaped = glob
    .replace(/[.+^$(){}|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.')
  return new RegExp('^' + escaped + '$')
}

function matchAny(name, patterns) {
  return patterns.some((p) => globToRegex(p).test(name))
}

/** Agent 身份：0.2.x 的 Agent 暴露 id（= SessionId）；兼容旧版的 session.id。 */
function agentIdOf(agent) {
  return agent?.id?.toString?.() ?? agent?.session?.id?.toString?.() ?? 'unknown'
}

export function apply(ctx, rawConfig) {
  const config = { ...DEFAULTS, ...rawConfig }
  const ledgers = new Map()
  // agentId -> 当前 turn 号。0.2.x 的 Agent 没有 currentTurn；由 agent/pre-step
  // 的 event.turn 捕获（每个模型步都会带当前 turn），旧内核回退 agent.currentTurn。
  const turns = new Map()

  function getLedger(agentId, turn) {
    let ledger = ledgers.get(agentId)
    if (!ledger || ledger.turn !== turn) {
      ledger = {
        turn,
        toolCallsThisTurn: 0,
        stepsThisTurn: 0,
        callSignatures: new Map(),
        consecutiveFailures: new Map(),
        deniedSignatures: new Set(),
      }
      ledgers.set(agentId, ledger)
    }
    return ledger
  }

  function turnOf(agent, agentId) {
    return turns.get(agentId) ?? agent?.currentTurn ?? 0
  }

  function signatureOf(toolName, args) {
    try {
      return toolName + '::' + JSON.stringify(args ?? {})
    } catch {
      return toolName + '::<unserializable>'
    }
  }

  ctx.on('tools/pre-execute', async (exec, next) => {
    const agent = exec.agent
    const agentId = agentIdOf(agent)
    const turn = turnOf(agent, agentId)
    const ledger = getLedger(agentId, turn)

    if (matchAny(exec.name, config.denyTools)) {
      return { kind: 'deny', reason: '工具 "' + exec.name + '" 在黑名单中，禁止调用。' }
    }
    if (ledger.toolCallsThisTurn >= config.maxToolCallsPerTurn) {
      return {
        kind: 'deny',
        reason: '本回合工具调用已达上限（' + config.maxToolCallsPerTurn + '），' + config.denyMessage,
      }
    }

    const sig = signatureOf(exec.name, exec.arguments)
    const repeatCount = (ledger.callSignatures.get(sig) ?? 0) + 1
    ledger.callSignatures.set(sig, repeatCount)

    if (repeatCount > config.repeatThreshold) {
      ledger.deniedSignatures.add(sig)
      return { kind: 'deny', reason: '相同调用已重复 ' + repeatCount + ' 次。' + config.denyMessage }
    }

    const failCount = ledger.consecutiveFailures.get(exec.name) ?? 0
    if (failCount >= config.consecutiveFailureThreshold) {
      return {
        kind: 'deny',
        reason: '工具 "' + exec.name + '" 已连续失败 ' + failCount + ' 次，暂停使用。' + config.denyMessage,
      }
    }

    return next()
  })

  ctx.on('tools/post-execute', async (exec, result, next) => {
    const agent = exec.agent
    const agentId = agentIdOf(agent)
    const turn = turnOf(agent, agentId)
    const ledger = getLedger(agentId, turn)

    ledger.toolCallsThisTurn++

    const isError =
      result?.isError === true ||
      (Array.isArray(result?.content) &&
        result.content.some(
          (b) =>
            b?.type === 'text' &&
            typeof b.text === 'string' &&
            /error|failed|失败|异常/i.test(b.text.slice(0, 200))
        ))

    if (isError) {
      const prev = ledger.consecutiveFailures.get(exec.name) ?? 0
      ledger.consecutiveFailures.set(exec.name, prev + 1)
    } else {
      ledger.consecutiveFailures.set(exec.name, 0)
    }

    return next()
  })

  ctx.tools.guard((exec) => {
    const agent = exec.agent
    const agentId = agentIdOf(agent)
    const turn = turnOf(agent, agentId)
    const ledger = getLedger(agentId, turn)

    const sig = signatureOf(exec.name, exec.arguments)
    if (ledger.deniedSignatures.has(sig)) {
      return '调用 "' + exec.name + '" 已被治理插件在更早阶段拒绝，不再重复尝试。'
    }
    if (ledger.toolCallsThisTurn >= config.maxToolCallsPerTurn) {
      return '本回合工具预算已耗尽（' + config.maxToolCallsPerTurn + ' 次）。请直接给出最终答复。'
    }
    return undefined
  })

  ctx.on('agent/pre-step', async (event, next) => {
    const agent = event.agent
    const agentId = agentIdOf(agent)
    if (typeof event?.turn === 'number') turns.set(agentId, event.turn)
    const turn = turnOf(agent, agentId)
    const ledger = getLedger(agentId, turn)

    ledger.stepsThisTurn++

    if (ledger.stepsThisTurn > config.maxStepsPerTurn) {
      ctx.logger?.warn?.(
        'dsh-tool-governor: agent "' + agentId + '" 在 turn ' + turn + ' 超过 ' +
          config.maxStepsPerTurn + ' 个模型步，结束本回合'
      )
      return { kind: 'reject' }
    }

    return next()
  })
}
