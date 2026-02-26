import type { IncomingMessage, ServerResponse } from 'http'
import { createPublicClient, http, formatUnits } from 'viem'

type VercelRequest = IncomingMessage & { url: string; method: string; headers: any; body?: any; query?: any }
type VercelResponse = ServerResponse & { json: (data: any) => VercelResponse; status: (code: number) => VercelResponse; setHeader: (name: string, value: string) => VercelResponse; send: (body: any) => VercelResponse; end: () => void }
import { mainnet } from 'viem/chains'

const ChainlinkAggregator = [
  {
    inputs: [],
    name: 'latestRoundData',
    outputs: [
      { internalType: 'uint80', name: 'roundId', type: 'uint80' },
      { internalType: 'int256', name: 'answer', type: 'int256' },
      { internalType: 'uint256', name: 'startedAt', type: 'uint256' },
      { internalType: 'uint256', name: 'updatedAt', type: 'uint256' },
      { internalType: 'uint80', name: 'answeredInRound', type: 'uint80' },
    ],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [],
    name: 'decimals',
    outputs: [{ internalType: 'uint8', name: '', type: 'uint8' }],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [],
    name: 'description',
    outputs: [{ internalType: 'string', name: '', type: 'string' }],
    stateMutability: 'view',
    type: 'function',
  },
] as const

const CHAINLINK_FEED_ADDRESS = '0xa81FE04086865e63E12dD3776978E49DEEa2ea4e' as `0x${string}`
const CHAINLINK_RPC = process.env.CHAINLINK_RPC || 'https://ethereum-rpc.publicnode.com'
const EXPECTED_RESERVES_MULTIPLIER = 0.95
const WBTC_USD_PRICE = 67_000

const mainnetClient = createPublicClient({
  chain: mainnet,
  transport: http(CHAINLINK_RPC),
})

// Chainlink data cache (30s TTL)
let chainlinkCache: any = null
const CHAINLINK_CACHE_TTL = 30_000

async function fetchChainlinkData() {
  if (chainlinkCache && (Date.now() - chainlinkCache.fetchedAt) < CHAINLINK_CACHE_TTL) {
    return chainlinkCache
  }

  const [roundData, decimals, description] = await Promise.all([
    mainnetClient.readContract({
      address: CHAINLINK_FEED_ADDRESS,
      abi: ChainlinkAggregator,
      functionName: 'latestRoundData',
    } as any),
    mainnetClient.readContract({
      address: CHAINLINK_FEED_ADDRESS,
      abi: ChainlinkAggregator,
      functionName: 'decimals',
    } as any),
    mainnetClient.readContract({
      address: CHAINLINK_FEED_ADDRESS,
      abi: ChainlinkAggregator,
      functionName: 'description',
    } as any),
  ])

  const [roundId, answer, , updatedAt] = roundData as any[]
  const formatted = formatUnits(answer, decimals as number)

  chainlinkCache = {
    answer: formatted,
    answerRaw: answer,
    decimals,
    description,
    updatedAt: Number(updatedAt),
    roundId: roundId.toString(),
    feedAddress: CHAINLINK_FEED_ADDRESS,
    fetchedAt: Date.now(),
  }

  return chainlinkCache
}

// In-memory state (persists while serverless instance is warm)
let overrideReserves: any = null
let overrideAttestation: any = null
const events: any[] = []
const agentActivity: any[] = []
let agentMetrics: any = null
const recoveryHistory: any[] = []
const ratioHistory: any[] = []

function initMetrics() {
  if (!agentMetrics) {
    agentMetrics = {
      totalRecoveries: 0, successfulRecoveries: 0, failedRecoveries: 0,
      successRate: 0, avgResponseTimeMs: 0, uptimeSeconds: 60,
      errorCount: 0, recentErrors: [],
    }
  }
}

// CORS headers
function setCors(res: VercelResponse) {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  setCors(res)

  if (req.method === 'OPTIONS') {
    return res.status(200).end()
  }

  const url = new URL(req.url || '/', `http://${req.headers.host}`)
  const path = url.pathname

  try {
    // GET /api/status
    if (path === '/api/status' && req.method === 'GET') {
      // Expire overrides
      if (overrideReserves && Date.now() > overrideReserves.expiresAt) overrideReserves = null
      if (overrideAttestation && Date.now() > overrideAttestation.expiresAt) overrideAttestation = null

      let reserves: any
      if (overrideReserves) {
        reserves = {
          totalReserve: overrideReserves.totalReserve,
          totalLiabilities: overrideReserves.totalLiabilities,
          isSolvent: overrideReserves.isSolvent,
          source: 'override',
        }
      } else {
        try {
          const cl = await fetchChainlinkData()
          const totalReserve = Number(cl.answer)
          const totalLiabilities = totalReserve * EXPECTED_RESERVES_MULTIPLIER

          reserves = {
            totalReserve,
            totalLiabilities,
            isSolvent: totalReserve >= totalLiabilities,
            chainlink: {
              description: cl.description,
              updatedAt: cl.updatedAt,
              roundId: cl.roundId,
              feedAddress: cl.feedAddress,
              decimals: cl.decimals,
            },
            source: 'chainlink',
          }
        } catch {
          reserves = { totalReserve: 0, totalLiabilities: 0, isSolvent: true, source: 'override' }
        }
      }

      let contract = { isSolvent: true, lastUpdated: 0 }
      if (overrideAttestation) {
        contract = {
          isSolvent: overrideAttestation.isSolvent,
          lastUpdated: Math.floor(Date.now() / 1000),
        }
      }

      const ratio = reserves.totalLiabilities > 0
        ? reserves.totalReserve / reserves.totalLiabilities
        : 1
      ratioHistory.push({ timestamp: Date.now(), ratio })
      if (ratioHistory.length > 200) ratioHistory.splice(0, ratioHistory.length - 200)

      return res.json({
        reserves,
        contract,
        events,
        agent: {
          activities: agentActivity,
          recoveryCount: agentActivity.filter((a: any) => a.action === 'recovery').length,
          metrics: agentMetrics,
        },
        recoveries: recoveryHistory.slice(-10),
        alerts: {
          config: { enabled: false },
          recent: [],
        },
        ratioHistory: ratioHistory.slice(-50),
      })
    }

    // POST /api/simulate — small deficit, direct wallet swap
    if (path === '/api/simulate' && req.method === 'POST') {
      const now = Date.now()
      const cl = await fetchChainlinkData()
      const realReserve = Number(cl.answer)
      const feedDesc = cl.description
      const liabilities = realReserve * EXPECTED_RESERVES_MULTIPLIER
      const droppedReserve = liabilities * 0.9995
      const targetReserve = liabilities
      const recoveryAmount = targetReserve - droppedReserve
      const recoveryAmountUsd = Math.round(recoveryAmount * WBTC_USD_PRICE)
      const ratio = Math.floor((droppedReserve / liabilities) * 1000) / 10

      overrideReserves = {
        totalReserve: droppedReserve, totalLiabilities: liabilities,
        isSolvent: false, expiresAt: now + 10_000,
      }
      overrideAttestation = { isSolvent: false, expiresAt: now + 10_000 }

      events.push({ isSolvent: false, timestamp: Math.floor(now / 1000), blockNumber: events.length + 1 })
      agentActivity.push({
        action: 'monitor', timestamp: Math.floor(now / 1000),
        details: `Undercollateralization detected. Ratio dropped to ${ratio}%. Initiating direct wallet recovery.`,
      })

      // Schedule recovery after 3s
      setTimeout(() => {
        overrideReserves = null
        overrideAttestation = null
        const recoveryTime = Date.now()
        const fmtRecovery = recoveryAmount.toLocaleString('en-US', { maximumFractionDigits: 0 })
        const fmtUsd = '$' + recoveryAmountUsd.toLocaleString('en-US')

        recoveryHistory.push({
          timestamp: recoveryTime, success: true, durationMs: 300, mechanism: 'direct',
          steps: [
            { step: 'checkBalance', success: true, timestamp: recoveryTime, durationMs: 50, mechanism: 'direct', data: { balance: fmtUsd + ' USDC available in wallet' } },
            { step: 'trade', success: true, timestamp: recoveryTime + 100, durationMs: 150, mechanism: 'direct', data: { amount: 'Swapped ' + fmtUsd + ' USDC → ' + fmtRecovery + ' wBTC on Uniswap' } },
            { step: 'send', success: true, timestamp: recoveryTime + 300, durationMs: 100, mechanism: 'direct', data: { amount: fmtRecovery + ' wBTC sent to reserve', tx: '0x' + Math.random().toString(16).slice(2, 10) + '...' } },
          ],
          summary: { shortfall: liabilities - droppedReserve, recoveryAmount, recoveryAmountUsd, fromRatio: 99.9, toRatio: 100, feedDescription: feedDesc, mechanism: 'direct' },
        })

        events.push({ isSolvent: true, timestamp: Math.floor(recoveryTime / 1000), blockNumber: events.length + 1 })
        agentActivity.push({
          action: 'recovery', timestamp: Math.floor(recoveryTime / 1000),
          details: `Direct wallet swap complete. Recovered ${fmtRecovery} wBTC (${fmtUsd}) via Uniswap. Reserve restored to 100%.`,
        })

        initMetrics()
        agentMetrics.totalRecoveries++
        agentMetrics.successfulRecoveries++
        agentMetrics.successRate = (agentMetrics.successfulRecoveries / agentMetrics.totalRecoveries) * 100
      }, 3000)

      return res.json({
        ok: true, phase: 'undercollateralized', mechanism: 'direct',
        data: { totalReserve: droppedReserve, totalLiabilities: liabilities, ratio, feedDescription: feedDesc, recoveryAmount },
      })
    }

    // POST /api/simulate-large — large deficit, dark pool
    if (path === '/api/simulate-large' && req.method === 'POST') {
      const now = Date.now()
      const cl = await fetchChainlinkData()
      const realReserve = Number(cl.answer)
      const feedDesc = cl.description
      const liabilities = realReserve * EXPECTED_RESERVES_MULTIPLIER
      const droppedReserve = liabilities * 0.95
      const targetReserve = liabilities * 1.05
      const recoveryAmount = targetReserve - droppedReserve
      const recoveryAmountUsd = Math.round(recoveryAmount * WBTC_USD_PRICE)
      const ratio = Math.round((droppedReserve / liabilities) * 100)

      overrideReserves = {
        totalReserve: droppedReserve, totalLiabilities: liabilities,
        isSolvent: false, expiresAt: now + 12_000,
      }
      overrideAttestation = { isSolvent: false, expiresAt: now + 12_000 }

      events.push({ isSolvent: false, timestamp: Math.floor(now / 1000), blockNumber: events.length + 1 })
      agentActivity.push({
        action: 'monitor', timestamp: Math.floor(now / 1000),
        details: `Undercollateralization detected. Ratio dropped to ${ratio}%. Deficit too large for direct swap, routing to dark pool.`,
      })

      setTimeout(() => {
        overrideReserves = null
        overrideAttestation = null
        const recoveryTime = Date.now()
        const fmtRecovery = recoveryAmount.toLocaleString('en-US', { maximumFractionDigits: 0 })
        const fmtUsd = '$' + recoveryAmountUsd.toLocaleString('en-US')
        const orderId = 'DP-' + Math.random().toString(36).slice(2, 8).toUpperCase()
        const zkProof = '0x' + Array.from({ length: 8 }, () => Math.random().toString(16).slice(2, 4)).join('')

        recoveryHistory.push({
          timestamp: recoveryTime, success: true, durationMs: 2200, mechanism: 'darkpool',
          steps: [
            { step: 'encryptRequest', success: true, timestamp: recoveryTime, durationMs: 80, mechanism: 'darkpool', data: { algorithm: 'AES-256-GCM', payload: '128-byte encrypted order' } },
            { step: 'submitToPool', success: true, timestamp: recoveryTime + 100, durationMs: 120, mechanism: 'darkpool', data: { orderId, venue: 'Chainlink Confidential Dark Pool', amount: fmtRecovery + ' wBTC' } },
            { step: 'monitorFill', success: true, timestamp: recoveryTime + 250, durationMs: 1800, mechanism: 'darkpool', data: { fillPrice: 'TWAP ± 0.05%', matchedCounterparties: 3, executionLatency: '1.8s' } },
            { step: 'settle', success: true, timestamp: recoveryTime + 2100, durationMs: 200, mechanism: 'darkpool', data: { zkProof, settlementTx: '0x' + Math.random().toString(16).slice(2, 10) + '...', gasUsed: '145,230' } },
          ],
          summary: { shortfall: liabilities - droppedReserve, recoveryAmount, recoveryAmountUsd, fromRatio: 95, toRatio: 105, feedDescription: feedDesc, mechanism: 'darkpool' },
        })

        events.push({ isSolvent: true, timestamp: Math.floor(recoveryTime / 1000), blockNumber: events.length + 1 })
        agentActivity.push({
          action: 'recovery', timestamp: Math.floor(recoveryTime / 1000),
          details: `Dark pool recovery complete. Filled ${fmtRecovery} wBTC (${fmtUsd}) via confidential TEE matching.`,
        })

        initMetrics()
        agentMetrics.totalRecoveries++
        agentMetrics.successfulRecoveries++
        agentMetrics.successRate = (agentMetrics.successfulRecoveries / agentMetrics.totalRecoveries) * 100
      }, 4000)

      return res.json({
        ok: true, phase: 'undercollateralized', mechanism: 'darkpool',
        data: { totalReserve: droppedReserve, totalLiabilities: liabilities, ratio, feedDescription: feedDesc, recoveryAmount },
      })
    }

    // POST /api/simulate-failure — dark pool failure
    if (path === '/api/simulate-failure' && req.method === 'POST') {
      const now = Date.now()
      const cl = await fetchChainlinkData()
      const realReserve = Number(cl.answer)
      const feedDesc = cl.description
      const liabilities = realReserve * EXPECTED_RESERVES_MULTIPLIER
      const droppedReserve = liabilities * 0.95
      const targetReserve = liabilities * 1.05
      const recoveryAmount = targetReserve - droppedReserve
      const fmtRecovery = recoveryAmount.toLocaleString('en-US', { maximumFractionDigits: 0 })
      const fmtUsd = '$' + Math.round(recoveryAmount * WBTC_USD_PRICE).toLocaleString('en-US')
      const orderId = 'DP-' + Math.random().toString(36).slice(2, 8).toUpperCase()

      overrideReserves = {
        totalReserve: droppedReserve, totalLiabilities: liabilities,
        isSolvent: false, expiresAt: now + 600_000,
      }
      overrideAttestation = { isSolvent: false, expiresAt: now + 600_000 }

      events.push({ isSolvent: false, timestamp: Math.floor(now / 1000), blockNumber: events.length + 1 })
      agentActivity.push({
        action: 'monitor', timestamp: Math.floor(now / 1000),
        details: `Undercollateralization detected. Ratio dropped to 95%. Routing ${fmtRecovery} wBTC (${fmtUsd}) to dark pool.`,
      })

      recoveryHistory.push({
        timestamp: now, success: false, durationMs: 5200, mechanism: 'darkpool',
        steps: [
          { step: 'encryptRequest', success: true, timestamp: now, durationMs: 80, mechanism: 'darkpool', data: { algorithm: 'AES-256-GCM', payload: '128-byte encrypted order' } },
          { step: 'submitToPool', success: true, timestamp: now + 100, durationMs: 120, mechanism: 'darkpool', data: { orderId, venue: 'Chainlink Confidential Dark Pool', amount: fmtRecovery + ' wBTC' } },
          { step: 'monitorFill', success: false, timestamp: now + 250, durationMs: 5000, mechanism: 'darkpool', data: { error: 'TEE matching engine timed out. Insufficient dark pool liquidity for ' + fmtRecovery + ' wBTC' } },
          { step: 'settle', success: false, timestamp: now + 5300, durationMs: 0, mechanism: 'darkpool', data: { error: 'Skipped, previous step failed' } },
        ],
        summary: { shortfall: liabilities - droppedReserve, recoveryAmount, fromRatio: 95, toRatio: 105, feedDescription: feedDesc, mechanism: 'darkpool' },
      })

      initMetrics()
      agentMetrics.totalRecoveries++
      agentMetrics.failedRecoveries++
      agentMetrics.errorCount++
      agentMetrics.successRate = (agentMetrics.successfulRecoveries / agentMetrics.totalRecoveries) * 100

      agentActivity.push({
        action: 'recovery', timestamp: Math.floor(now / 1000),
        details: `Dark pool recovery FAILED. TEE matching engine timed out for ${fmtRecovery} wBTC (${fmtUsd}). Manual intervention required.`,
      })

      return res.json({
        ok: true, phase: 'failed', mechanism: 'darkpool',
        data: { totalReserve: droppedReserve, totalLiabilities: liabilities, failedStep: 'Dark Pool Fill', error: 'TEE matching engine timed out', feedDescription: feedDesc },
      })
    }

    // POST /api/reset
    if (path === '/api/reset' && req.method === 'POST') {
      overrideReserves = null
      overrideAttestation = null
      return res.json({ ok: true })
    }

    // POST /api/agent-activity
    if (path === '/api/agent-activity' && req.method === 'POST') {
      return res.json({ ok: true })
    }

    // POST /api/alerts/test
    if (path === '/api/alerts/test' && req.method === 'POST') {
      return res.json({ ok: true, message: 'Test alert sent (demo mode)' })
    }

    // GET /api/alerts/config
    if (path === '/api/alerts/config' && req.method === 'GET') {
      return res.json({ enabled: false })
    }

    return res.status(404).json({ error: 'Not found' })
  } catch (err: any) {
    console.error('API error:', err)
    return res.status(500).json({ error: err.message || 'Internal server error' })
  }
}
