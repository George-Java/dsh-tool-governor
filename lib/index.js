export const name = 'dsh-tool-governor'
// 0.2.x：只注入 tools；agent 从 exec.agent / event.agent 取。
export const inject = ['tools']

const DEFAULTS = {
  // 0 = 不限制。正常的多步任务不应该被“每回合调用次数”误伤；
  // 真正的死循环由“同签名重复”和“连续失败”两条规则拦截。
  maxToolCallsPerTurn: 0,
  maxStepsPerTurn: 0,
  // 同一 tool+args 第 (N+1) 次调用才拒绝。
  repeatThreshold: 3,
  // 同一个工具连续失败 N 次后暂停。
  consecutiveFailureThreshold: 3,
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

/** 新的用户消息 = 新回合：清掉该 agent 的账本，重复/失败计数从头开始。 */
function isUserMessage(message) {
  const source = message?.source
  return source?.kind === 'user' || source?.type === 'user'
}

export function apply(ctx, rawConfig) {
  const config = { ...DEFAULTS, ...(rawConfig && typeof rawConfig === 'object' ? rawConfig : {}) }
  const maxCalls = Number(config.maxToolCallsPerTurn) || 0
  const maxSteps = Number(config.maxStepsPerTurn) || 0
  const repeatThreshold = Math.max(1, Number(config.repeatThreshold) || DEFAULTS.repeatThreshold)
  const failureThreshold = Math.max(1, Number(config.consecutiveFailureThreshold) || DEFAULTS.consecutiveFailureThreshold)

  const ledgers = new Map()
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
    if (maxCalls > 0 && ledger.toolCallsThisTurn >= maxCalls) {
      return {
        kind: 'deny',
        reason: '本回合工具调用已达上限（' + maxCalls + '），' + config.denyMessage,
      }
    }

    const sig = signatureOf(exec.name, exec.arguments)
    const repeatCount = (ledger.callSignatures.get(sig) ?? 0) + 1
    ledger.callSignatures.set(sig, repeatCount)

    if (repeatCount > repeatThreshold) {
      ledger.deniedSignatures.add(sig)
      return {
        kind: 'deny',
        reason: '相同调用已重复 ' + repeatCount + ' 次（阈值 ' + repeatThreshold + '）。' + config.denyMessage,
      }
    }

    const failCount = ledger.consecutiveFailures.get(exec.name) ?? 0
    if (failCount >= failureThreshold) {
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

    // 只认结构化错误：工具输出里出现 error/failed 不代表调用失败。
    const isError = result?.isError === true

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
    if (maxCalls > 0 && ledger.toolCallsThisTurn >= maxCalls) {
      return '本回合工具预算已耗尽（' + maxCalls + ' 次）。请直接给出最终答复。'
    }
    return undefined
  })

  ctx.on('agent/pre-step', async (event, next) => {
    const agent = event.agent
    const agentId = agentIdOf(agent)
    const messages = Array.isArray(event?.messages) ? event.messages : []

    if (messages.some(isUserMessage)) {
      ledgers.delete(agentId)
      turns.delete(agentId)
    }
    if (typeof event?.turn === 'number') turns.set(agentId, event.turn)

    if (maxSteps > 0) {
      const turn = turnOf(agent, agentId)
      const ledger = getLedger(agentId, turn)
      ledger.stepsThisTurn++
      if (ledger.stepsThisTurn > maxSteps) {
        ctx.logger?.warn?.(
          'dsh-tool-governor: agent "' + agentId + '" 在 turn ' + turn + ' 超过 ' + maxSteps + ' 个模型步，结束本回合'
        )
        return { kind: 'reject' }
      }
    }

    return next()
  })
}
