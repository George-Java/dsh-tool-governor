export const name = 'dsh-tool-governor'
export const inject = ['tools','agent']

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
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.')
  return new RegExp(`^${escaped}$`)
}

function matchAny(name, patterns) {
  return patterns.some((p) => globToRegex(p).test(name))
}

export function apply(ctx, rawConfig) {
  const config = { ...DEFAULTS, ...rawConfig }
  const ledgers = new Map()

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

  function signatureOf(toolName, args) {
    try {
      return `${toolName}::${JSON.stringify(args ?? {})}`
    } catch {
      return `${toolName}::<unserializable>`
    }
  }

  ctx.on('tools/pre-execute', async (exec, next) => {
    const agent = ctx.agent
    const agentId = agent?.id?.toString?.() ?? 'unknown'
    const turn = agent?.currentTurn ?? 0
    const ledger = getLedger(agentId, turn)

    if (matchAny(exec.name, config.denyTools)) {
      return { kind: 'deny', reason: `工具 "${exec.name}" 在黑名单中，禁止调用。` }
    }
    if (ledger.toolCallsThisTurn >= config.maxToolCallsPerTurn) {
      return { kind: 'deny', reason: `本回合工具调用已达上限（${config.maxToolCallsPerTurn}），${config.denyMessage}` }
    }

    const sig = signatureOf(exec.name, exec.arguments)
    const repeatCount = (ledger.callSignatures.get(sig) ?? 0) + 1
    ledger.callSignatures.set(sig, repeatCount)

    if (repeatCount > config.repeatThreshold) {
      ledger.deniedSignatures.add(sig)
      return { kind: 'deny', reason: `相同调用已重复 ${repeatCount} 次。${config.denyMessage}` }
    }

    const failCount = ledger.consecutiveFailures.get(exec.name) ?? 0
    if (failCount >= config.consecutiveFailureThreshold) {
      return { kind: 'deny', reason: `工具 "${exec.name}" 已连续失败 ${failCount} 次，暂停使用。${config.denyMessage}` }
    }

    return next()
  })

  ctx.on('tools/post-execute', async (exec, result, next) => {
    const agent = ctx.agent
    const agentId = agent?.id?.toString?.() ?? 'unknown'
    const turn = agent?.currentTurn ?? 0
    const ledger = getLedger(agentId, turn)

    ledger.toolCallsThisTurn++

    const isError =
      result?.isError === true ||
      (Array.isArray(result?.content) &&
        result.content.some(
          (b) => b?.type === 'text' && typeof b.text === 'string' && /error|failed|失败|异常/i.test(b.text.slice(0, 200))
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
    const agent = ctx.agent
    const agentId = agent?.id?.toString?.() ?? 'unknown'
    const turn = agent?.currentTurn ?? 0
    const ledger = getLedger(agentId, turn)

    const sig = signatureOf(exec.name, exec.arguments)
    if (ledger.deniedSignatures.has(sig)) {
      return `调用 "${exec.name}" 已被治理插件在更早阶段拒绝，不再重复尝试。`
    }
    if (ledger.toolCallsThisTurn >= config.maxToolCallsPerTurn) {
      return `本回合工具预算已耗尽（${config.maxToolCallsPerTurn} 次）。请直接给出最终答复。`
    }
    return undefined
  })

  ctx.on('agent/pre-step', async (event, next) => {
    const agent = ctx.agent
    const agentId = agent?.id?.toString?.() ?? 'unknown'
    const turn = agent?.currentTurn ?? 0
    const ledger = getLedger(agentId, turn)

    ledger.stepsThisTurn++

    if (ledger.stepsThisTurn > config.maxStepsPerTurn) {
      return { kind: 'block', reason: `本回合模型步数已达上限（${config.maxStepsPerTurn} 步），强制结束当前 turn。` }
    }

    return next()
  })
}