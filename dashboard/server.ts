import express from 'express'
import path from 'path'
import { fileURLToPath } from 'url'
import { createPublicClient, http, formatUnits } from 'viem'
import { hardhat, mainnet } from 'viem/chains'
import { ReserveAttestation } from '../contracts/abi/ReserveAttestation'
import { ChainlinkAggregator } from '../contracts/abi/ChainlinkAggregator'
import { AlertManager } from './alerts'

const app = express()
app.use(express.json())

const RPC_URL = process.env.RPC_URL || 'http://127.0.0.1:8545'
const API_URL = process.env.MOCK_API_URL || 'http://127.0.0.1:3001'
let CONTRACT_ADDRESS = process.env.CONTRACT_ADDRESS as `0x${string}` | undefined
const PORT = process.env.DASHBOARD_PORT || 3002
const PUBLIC_URL = process.env.PUBLIC_URL || 'localhost'
const BIND_HOST = process.env.BIND_HOST || '127.0.0.1' // Localhost only for production security

// Chainlink PoR feed config
const CHAINLINK_FEED_ADDRESS = (process.env.CHAINLINK_FEED_ADDRESS || '0xa81FE04086865e63E12dD3776978E49DEEa2ea4e') as `0x${string}`
const CHAINLINK_RPC = process.env.CHAINLINK_RPC || 'https://ethereum-rpc.publicnode.com'
const EXPECTED_RESERVES_MULTIPLIER = Number(process.env.EXPECTED_RESERVES_MULTIPLIER || '0.95')
const WBTC_USD_PRICE = 67_000 // approximate wBTC price for USD display

// Mainnet client for Chainlink reads
const mainnetClient = createPublicClient({
  chain: mainnet,
  transport: http(CHAINLINK_RPC),
})

// Chainlink data cache (30s TTL to avoid hammering public RPC)
let chainlinkCache: {
  answer: string
  answerRaw: bigint
  decimals: number
  description: string
  updatedAt: number
  roundId: string
  feedAddress: string
  fetchedAt: number
} | null = null
const CHAINLINK_CACHE_TTL = 30_000

async function fetchChainlinkData() {
  // Return cache if fresh
  if (chainlinkCache && (Date.now() - chainlinkCache.fetchedAt) < CHAINLINK_CACHE_TTL) {
    return chainlinkCache
  }

  const [roundData, decimals, description] = await Promise.all([
    mainnetClient.readContract({
      address: CHAINLINK_FEED_ADDRESS,
      abi: ChainlinkAggregator,
      functionName: 'latestRoundData',
    }),
    mainnetClient.readContract({
      address: CHAINLINK_FEED_ADDRESS,
      abi: ChainlinkAggregator,
      functionName: 'decimals',
    }),
    mainnetClient.readContract({
      address: CHAINLINK_FEED_ADDRESS,
      abi: ChainlinkAggregator,
      functionName: 'description',
    }),
  ])

  const [roundId, answer, , updatedAt] = roundData
  const formatted = formatUnits(answer, decimals)

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

// Override reserves for simulate buttons (null = use Chainlink data)
let overrideReserves: {
  totalReserve: number
  totalLiabilities: number
  isSolvent: boolean
  expiresAt: number
} | null = null

// Override attestation status during simulations (null = use real contract)
let overrideAttestation: {
  isSolvent: boolean
  expiresAt: number
} | null = null

// Serve static files
const __dirname = path.dirname(fileURLToPath(import.meta.url))
app.use(express.static(path.join(__dirname, 'public')))

// Initialize alerts
const alertManager = new AlertManager()

// In-memory event log
const events: Array<{
  isSolvent: boolean
  timestamp: number
  blockNumber: number
}> = []

// Agent activity log
const agentActivity: Array<{
  action: string
  timestamp: number
  details?: string
}> = []

// Agent metrics (from latest report)
let agentMetrics: any = null

// Recovery history (last 100)
const recoveryHistory: Array<{
  timestamp: number
  success: boolean
  durationMs: number
  steps: any[]
}> = []

// Ratio history for chart (capped at 200)
const ratioHistory: Array<{ timestamp: number; ratio: number }> = []

// GET /api/status — aggregated dashboard data
app.get('/api/status', async (_req, res) => {
  try {
    // Check if override is active and not expired
    if (overrideReserves && Date.now() > overrideReserves.expiresAt) {
      overrideReserves = null
    }

    // Build reserves object
    let reserves: {
      totalReserve: number
      totalLiabilities: number
      isSolvent: boolean
      chainlink?: {
        description: string
        updatedAt: number
        roundId: string
        feedAddress: string
        decimals: number
      }
      source: 'chainlink' | 'override'
    }

    if (overrideReserves) {
      // Use override from simulate buttons
      reserves = {
        totalReserve: overrideReserves.totalReserve,
        totalLiabilities: overrideReserves.totalLiabilities,
        isSolvent: overrideReserves.isSolvent,
        source: 'override',
      }
    } else {
      // Use real Chainlink data
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
      } catch (clErr) {
        // Fallback to mock API if Chainlink fails
        let mockData = { totalReserve: 0, totalLiabilities: 0, isSolvent: true }
        try {
          const apiRes = await fetch(`${API_URL}/reserves`)
          if (apiRes.ok) mockData = await apiRes.json()
        } catch {}
        reserves = { ...mockData, source: 'override' }
      }
    }

    // Check if attestation override is active and not expired
    if (overrideAttestation && Date.now() > overrideAttestation.expiresAt) {
      overrideAttestation = null
    }

    // Read contract state (or use override during simulations)
    let contract = { isSolvent: true, lastUpdated: 0 }
    if (overrideAttestation) {
      contract = {
        isSolvent: overrideAttestation.isSolvent,
        lastUpdated: Math.floor(Date.now() / 1000),
      }
    } else if (CONTRACT_ADDRESS) {
      try {
        const client = createPublicClient({
          chain: hardhat,
          transport: http(RPC_URL),
        })
        const [solvent, lastUpdated] = await Promise.all([
          client.readContract({
            address: CONTRACT_ADDRESS,
            abi: ReserveAttestation,
            functionName: 'isSolvent',
          }),
          client.readContract({
            address: CONTRACT_ADDRESS,
            abi: ReserveAttestation,
            functionName: 'lastUpdated',
          }),
        ])
        contract = {
          isSolvent: solvent as boolean,
          lastUpdated: Number(lastUpdated as bigint),
        }
      } catch {}
    }

    // Track ratio history
    const ratio = reserves.totalLiabilities > 0
      ? reserves.totalReserve / reserves.totalLiabilities
      : 1
    ratioHistory.push({ timestamp: Date.now(), ratio })
    if (ratioHistory.length > 200) ratioHistory.splice(0, ratioHistory.length - 200)

    res.json({
      reserves,
      contract,
      events,
      agent: {
        activities: agentActivity,
        recoveryCount: agentActivity.filter(a => a.action === 'recovery').length,
        metrics: agentMetrics,
      },
      recoveries: recoveryHistory.slice(-10),
      alerts: {
        config: alertManager.getConfig(),
        recent: alertManager.getHistory(10),
      },
      ratioHistory: ratioHistory.slice(-50),
    })
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch status' })
  }
})

// POST /api/agent-activity — agent reports actions and metrics here
app.post('/api/agent-activity', async (req, res) => {
  try {
    const { action, details, metrics, recovery, timestamp } = req.body

    // Legacy support
    if (action) {
      agentActivity.push({
        action,
        timestamp: timestamp || Math.floor(Date.now() / 1000),
        details,
      })
    }

    // Update metrics
    if (metrics) {
      agentMetrics = metrics
    }

    // Track recovery history
    if (recovery) {
      recoveryHistory.push({
        timestamp: timestamp || Date.now(),
        success: recovery.success,
        durationMs: recovery.durationMs,
        steps: recovery.steps,
      })

      // Keep only last 100 recoveries
      if (recoveryHistory.length > 100) {
        recoveryHistory.splice(0, recoveryHistory.length - 100)
      }

      // Send alert on recovery failure
      if (!recovery.success) {
        const failedStep = recovery.steps.find((s: any) => !s.success)
        await alertManager.sendAlert(
          'RECOVERY_FAILURE',
          `Recovery failed at step: ${failedStep?.step || 'unknown'}`,
          { recovery, metrics }
        )
      }
    }

    res.json({ ok: true })
  } catch (err) {
    console.error('[dashboard] Error processing agent activity:', err)
    res.status(500).json({ error: 'Failed to process agent activity' })
  }
})

// GET /api/recoveries — recovery history with pagination
app.get('/api/recoveries', (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 10, 100)
  const offset = Number(req.query.offset) || 0

  const slice = recoveryHistory.slice(-(offset + limit), -offset || undefined)

  res.json({
    total: recoveryHistory.length,
    limit,
    offset,
    recoveries: slice,
  })
})

// GET /api/export/events.json
app.get('/api/export/events.json', (req, res) => {
  try {
    let filtered = events

    if (req.query.since) {
      const since = Number(req.query.since)
      filtered = filtered.filter(e => e.timestamp >= since)
    }

    if (req.query.until) {
      const until = Number(req.query.until)
      filtered = filtered.filter(e => e.timestamp <= until)
    }

    if (req.query.limit) {
      const limit = Number(req.query.limit)
      filtered = filtered.slice(-limit)
    }

    res.setHeader('Content-Disposition', 'attachment; filename="events.json"')
    res.setHeader('Content-Type', 'application/json')
    res.json(filtered)
  } catch (err) {
    res.status(500).json({ error: 'Failed to export events' })
  }
})

// GET /api/export/events.csv
app.get('/api/export/events.csv', (req, res) => {
  try {
    let filtered = events

    if (req.query.since) {
      const since = Number(req.query.since)
      filtered = filtered.filter(e => e.timestamp >= since)
    }

    if (req.query.until) {
      const until = Number(req.query.until)
      filtered = filtered.filter(e => e.timestamp <= until)
    }

    if (req.query.limit) {
      const limit = Number(req.query.limit)
      filtered = filtered.slice(-limit)
    }

    const csv = [
      'isSolvent,timestamp,blockNumber,time',
      ...filtered.map(e =>
        `${e.isSolvent},${e.timestamp},${e.blockNumber},${new Date(e.timestamp * 1000).toISOString()}`
      ),
    ].join('\n')

    res.setHeader('Content-Disposition', 'attachment; filename="events.csv"')
    res.setHeader('Content-Type', 'text/csv')
    res.send(csv)
  } catch (err) {
    res.status(500).json({ error: 'Failed to export events' })
  }
})

// GET /api/export/activities.json
app.get('/api/export/activities.json', (req, res) => {
  try {
    let filtered = agentActivity

    if (req.query.since) {
      const since = Number(req.query.since)
      filtered = filtered.filter(a => a.timestamp >= since)
    }

    if (req.query.until) {
      const until = Number(req.query.until)
      filtered = filtered.filter(a => a.timestamp <= until)
    }

    if (req.query.limit) {
      const limit = Number(req.query.limit)
      filtered = filtered.slice(-limit)
    }

    res.setHeader('Content-Disposition', 'attachment; filename="activities.json"')
    res.setHeader('Content-Type', 'application/json')
    res.json(filtered)
  } catch (err) {
    res.status(500).json({ error: 'Failed to export activities' })
  }
})

// GET /api/export/activities.csv
app.get('/api/export/activities.csv', (req, res) => {
  try {
    let filtered = agentActivity

    if (req.query.since) {
      const since = Number(req.query.since)
      filtered = filtered.filter(a => a.timestamp >= since)
    }

    if (req.query.until) {
      const until = Number(req.query.until)
      filtered = filtered.filter(a => a.timestamp <= until)
    }

    if (req.query.limit) {
      const limit = Number(req.query.limit)
      filtered = filtered.slice(-limit)
    }

    const csv = [
      'action,timestamp,details,time',
      ...filtered.map(a =>
        `${a.action},${a.timestamp},"${(a.details || '').replace(/"/g, '""')}",${new Date(a.timestamp * 1000).toISOString()}`
      ),
    ].join('\n')

    res.setHeader('Content-Disposition', 'attachment; filename="activities.csv"')
    res.setHeader('Content-Type', 'text/csv')
    res.send(csv)
  } catch (err) {
    res.status(500).json({ error: 'Failed to export activities' })
  }
})

// GET /api/alerts/config
app.get('/api/alerts/config', (_req, res) => {
  res.json(alertManager.getConfig())
})

// POST /api/alerts/test
app.post('/api/alerts/test', async (_req, res) => {
  try {
    await alertManager.sendAlert(
      'RECOVERY_FAILURE',
      'This is a test alert from the Self-Healing Reserve dashboard',
      { test: true, timestamp: Date.now() }
    )
    res.json({ ok: true, message: 'Test alert sent to all enabled channels' })
  } catch (err) {
    res.status(500).json({ error: 'Failed to send test alert' })
  }
})

// POST /api/simulate - Simulate a small deficit recovery (direct wallet swap)
// Snapshots real Chainlink data, drops ratio to 99%, agent computes deficit and swaps via wallet
app.post('/api/simulate', async (_req, res) => {
  try {
    const now = Date.now()

    const cl = await fetchChainlinkData()
    const realReserve = Number(cl.answer)
    const feedDesc = cl.description

    const liabilities = realReserve * EXPECTED_RESERVES_MULTIPLIER
    // Drop reserve to 99.95% of liabilities (small shortfall)
    const droppedReserve = liabilities * 0.9995
    // Recovery target: restore to 100% (direct swap can only close the gap, not over-collateralize)
    const targetReserve = liabilities
    const recoveryAmount = targetReserve - droppedReserve
    const recoveryAmountUsd = Math.round(recoveryAmount * WBTC_USD_PRICE)

    overrideReserves = {
      totalReserve: droppedReserve,
      totalLiabilities: liabilities,
      isSolvent: false,
      expiresAt: now + 10_000,
    }

    overrideAttestation = {
      isSolvent: false,
      expiresAt: now + 10_000,
    }

    events.push({
      isSolvent: false,
      timestamp: Math.floor(now / 1000),
      blockNumber: events.length + 1,
    })

    const ratio = Math.floor((droppedReserve / liabilities) * 1000) / 10

    // Log agent activity
    agentActivity.push({
      action: 'monitor',
      timestamp: Math.floor(now / 1000),
      details: `Undercollateralization detected. Ratio dropped to ${ratio}%. Initiating direct wallet recovery.`,
    })

    res.json({
      ok: true,
      phase: 'undercollateralized',
      mechanism: 'direct',
      data: {
        totalReserve: droppedReserve,
        totalLiabilities: liabilities,
        ratio,
        feedDescription: feedDesc,
        recoveryAmount,
      },
    })

    // After 3 seconds, trigger recovery
    setTimeout(async () => {
      try {
        overrideReserves = null
        overrideAttestation = null

        const recoveryTime = Date.now()
        const fmtRecovery = recoveryAmount.toLocaleString('en-US', { maximumFractionDigits: 0 })
        const fmtUsd = '$' + recoveryAmountUsd.toLocaleString('en-US')

        const recoverySteps = [
          { step: 'checkBalance' as const, success: true, timestamp: recoveryTime, durationMs: 50, mechanism: 'direct' as const,
            data: { balance: fmtUsd + ' USDC available in wallet' } },
          { step: 'trade' as const, success: true, timestamp: recoveryTime + 100, durationMs: 150, mechanism: 'direct' as const,
            data: { amount: 'Swapped ' + fmtUsd + ' USDC \u2192 ' + fmtRecovery + ' wBTC on Uniswap' } },
          { step: 'send' as const, success: true, timestamp: recoveryTime + 300, durationMs: 100, mechanism: 'direct' as const,
            data: { amount: fmtRecovery + ' wBTC sent to reserve', tx: '0x' + Math.random().toString(16).slice(2, 10) + '...' } },
        ]

        recoveryHistory.push({
          timestamp: recoveryTime,
          success: true,
          durationMs: 300,
          steps: recoverySteps,
          mechanism: 'direct',
          summary: {
            shortfall: liabilities - droppedReserve,
            recoveryAmount,
            recoveryAmountUsd,
            fromRatio: 99.9,
            toRatio: 100,
            feedDescription: feedDesc,
            mechanism: 'direct',
          },
        })

        events.push({
          isSolvent: true,
          timestamp: Math.floor(recoveryTime / 1000),
          blockNumber: events.length + 1,
        })

        // Log agent activity
        agentActivity.push({
          action: 'recovery',
          timestamp: Math.floor(recoveryTime / 1000),
          details: `Direct wallet swap complete. Recovered ${fmtRecovery} wBTC (${fmtUsd}) via Uniswap. Reserve restored to 100%. Remaining 5% buffer replenished via scheduled OTC acquisition.`,
        })

        if (!agentMetrics) {
          agentMetrics = {
            totalRecoveries: 0, successfulRecoveries: 0, failedRecoveries: 0,
            successRate: 0, avgResponseTimeMs: 0, uptimeSeconds: 60,
            errorCount: 0, recentErrors: [],
          }
        }

        agentMetrics.totalRecoveries++
        agentMetrics.successfulRecoveries++
        agentMetrics.successRate = (agentMetrics.successfulRecoveries / agentMetrics.totalRecoveries) * 100
        agentMetrics.avgResponseTimeMs = ((agentMetrics.avgResponseTimeMs * (agentMetrics.totalRecoveries - 1)) + 300) / agentMetrics.totalRecoveries
      } catch (err) {
        console.error('[simulate] Recovery phase failed:', err)
      }
    }, 3000)
  } catch (err) {
    console.error('[simulate] Error:', err)
    res.status(500).json({ error: 'Failed to simulate recovery' })
  }
})

// POST /api/simulate-large - Simulate a large deficit recovery (confidential dark pool)
// Snapshots real Chainlink data, drops ratio to 95%, agent routes through dark pool
app.post('/api/simulate-large', async (_req, res) => {
  try {
    const now = Date.now()

    const cl = await fetchChainlinkData()
    const realReserve = Number(cl.answer)
    const feedDesc = cl.description

    const liabilities = realReserve * EXPECTED_RESERVES_MULTIPLIER
    // Drop reserve to 95% of liabilities (large shortfall)
    const droppedReserve = liabilities * 0.95
    // Recovery target: 105% collateralization
    const targetReserve = liabilities * 1.05
    const recoveryAmount = targetReserve - droppedReserve

    overrideReserves = {
      totalReserve: droppedReserve,
      totalLiabilities: liabilities,
      isSolvent: false,
      expiresAt: now + 12_000,
    }

    overrideAttestation = {
      isSolvent: false,
      expiresAt: now + 12_000,
    }

    events.push({
      isSolvent: false,
      timestamp: Math.floor(now / 1000),
      blockNumber: events.length + 1,
    })

    const ratio = Math.round((droppedReserve / liabilities) * 100)
    const recoveryAmountUsd = Math.round(recoveryAmount * WBTC_USD_PRICE)

    // Log agent activity
    agentActivity.push({
      action: 'monitor',
      timestamp: Math.floor(now / 1000),
      details: `Undercollateralization detected. Ratio dropped to ${ratio}%. Deficit too large for direct swap, routing to dark pool.`,
    })

    res.json({
      ok: true,
      phase: 'undercollateralized',
      mechanism: 'darkpool',
      data: {
        totalReserve: droppedReserve,
        totalLiabilities: liabilities,
        ratio,
        feedDescription: feedDesc,
        recoveryAmount,
      },
    })

    // After 4 seconds, trigger dark pool recovery
    setTimeout(async () => {
      try {
        overrideReserves = null
        overrideAttestation = null

        const recoveryTime = Date.now()
        const fmtRecovery = recoveryAmount.toLocaleString('en-US', { maximumFractionDigits: 0 })
        const fmtUsd = '$' + recoveryAmountUsd.toLocaleString('en-US')
        const orderId = 'DP-' + Math.random().toString(36).slice(2, 8).toUpperCase()
        const zkProof = '0x' + Array.from({ length: 8 }, () => Math.random().toString(16).slice(2, 4)).join('')

        const balanceHash = '0x' + Array.from({ length: 16 }, () => Math.random().toString(16).slice(2, 4)).join('')
        const cccAttestation = '0xCCC_' + Array.from({ length: 12 }, () => Math.random().toString(16).slice(2, 4)).join('')

        const recoverySteps = [
          { step: 'encryptRequest' as const, success: true, timestamp: recoveryTime, durationMs: 80, mechanism: 'darkpool' as const,
            data: { algorithm: 'CCC Threshold Encryption', payload: 'Encrypted under CCC master public key (threshold-shared across Vault DON)' } },
          { step: 'submitToPool' as const, success: true, timestamp: recoveryTime + 100, durationMs: 120, mechanism: 'darkpool' as const,
            data: { orderId, venue: 'Chainlink CCC Dark Pool', amount: fmtRecovery + ' wBTC' } },
          { step: 'monitorFill' as const, success: true, timestamp: recoveryTime + 250, durationMs: 1800, mechanism: 'darkpool' as const,
            data: { fillPrice: 'TWAP \u00B1 0.05%', matchedCounterparties: 3, settlement: 'CCC Private Token Transfer', executionLatency: '1.8s' } },
          { step: 'settle' as const, success: true, timestamp: recoveryTime + 2100, durationMs: 200, mechanism: 'darkpool' as const,
            data: { balanceHash, cccAttestation, settlementTx: '0x' + Math.random().toString(16).slice(2, 10) + '...', onChain: 'Encrypted balance hash + boolean + CCC attestation' } },
        ]

        recoveryHistory.push({
          timestamp: recoveryTime,
          success: true,
          durationMs: 2200,
          steps: recoverySteps,
          mechanism: 'darkpool',
          summary: {
            shortfall: liabilities - droppedReserve,
            recoveryAmount,
            recoveryAmountUsd,
            fromRatio: 95,
            toRatio: 105,
            feedDescription: feedDesc,
            mechanism: 'darkpool',
          },
        })

        events.push({
          isSolvent: true,
          timestamp: Math.floor(recoveryTime / 1000),
          blockNumber: events.length + 1,
        })

        // Log agent activity
        agentActivity.push({
          action: 'recovery',
          timestamp: Math.floor(recoveryTime / 1000),
          details: `CCC dark pool recovery complete. Filled ${fmtRecovery} wBTC (${fmtUsd}) via CCC enclave matching + private token transfer. Only encrypted balance hash on-chain.`,
        })

        if (!agentMetrics) {
          agentMetrics = {
            totalRecoveries: 0, successfulRecoveries: 0, failedRecoveries: 0,
            successRate: 0, avgResponseTimeMs: 0, uptimeSeconds: 60,
            errorCount: 0, recentErrors: [],
          }
        }

        agentMetrics.totalRecoveries++
        agentMetrics.successfulRecoveries++
        agentMetrics.successRate = (agentMetrics.successfulRecoveries / agentMetrics.totalRecoveries) * 100
        agentMetrics.avgResponseTimeMs = ((agentMetrics.avgResponseTimeMs * (agentMetrics.totalRecoveries - 1)) + 2200) / agentMetrics.totalRecoveries
      } catch (err) {
        console.error('[simulate-large] Recovery phase failed:', err)
      }
    }, 4000)
  } catch (err) {
    console.error('[simulate-large] Error:', err)
    res.status(500).json({ error: 'Failed to simulate large recovery' })
  }
})

// POST /api/simulate-failure - Simulate a failed dark pool recovery
// Snapshots real Chainlink data, drops ratio to 95%, dark pool matching times out
app.post('/api/simulate-failure', async (_req, res) => {
  try {
    const now = Date.now()

    const cl = await fetchChainlinkData()
    const realReserve = Number(cl.answer)
    const feedDesc = cl.description

    const liabilities = realReserve * EXPECTED_RESERVES_MULTIPLIER
    const droppedReserve = liabilities * 0.95
    const targetReserve = liabilities * 1.05
    const recoveryAmount = targetReserve - droppedReserve

    overrideReserves = {
      totalReserve: droppedReserve,
      totalLiabilities: liabilities,
      isSolvent: false,
      expiresAt: now + 600_000, // Persist until manually reset
    }

    overrideAttestation = {
      isSolvent: false,
      expiresAt: now + 600_000,
    }

    events.push({
      isSolvent: false,
      timestamp: Math.floor(now / 1000),
      blockNumber: events.length + 1,
    })

    const fmtRecovery = recoveryAmount.toLocaleString('en-US', { maximumFractionDigits: 0 })
    const fmtUsd = '$' + Math.round(recoveryAmount * WBTC_USD_PRICE).toLocaleString('en-US')
    const orderId = 'DP-' + Math.random().toString(36).slice(2, 8).toUpperCase()

    // Log agent activity
    agentActivity.push({
      action: 'monitor',
      timestamp: Math.floor(now / 1000),
      details: `Undercollateralization detected. Ratio dropped to 95%. Routing ${fmtRecovery} wBTC (${fmtUsd}) to dark pool.`,
    })

    const recoverySteps = [
      { step: 'encryptRequest' as const, success: true, timestamp: now, durationMs: 80, mechanism: 'darkpool' as const,
        data: { algorithm: 'CCC Threshold Encryption', payload: 'Encrypted under CCC master public key (threshold-shared across Vault DON)' } },
      { step: 'submitToPool' as const, success: true, timestamp: now + 100, durationMs: 120, mechanism: 'darkpool' as const,
        data: { orderId, venue: 'Chainlink CCC Dark Pool', amount: fmtRecovery + ' wBTC' } },
      { step: 'monitorFill' as const, success: false, timestamp: now + 250, durationMs: 5000, mechanism: 'darkpool' as const,
        data: { error: 'CCC enclave matching timed out. Insufficient dark pool liquidity for ' + fmtRecovery + ' wBTC' } },
      { step: 'settle' as const, success: false, timestamp: now + 5300, durationMs: 0, mechanism: 'darkpool' as const,
        data: { error: 'Skipped, previous step failed' } },
    ]

    recoveryHistory.push({
      timestamp: now,
      success: false,
      durationMs: 5200,
      steps: recoverySteps,
      mechanism: 'darkpool',
      summary: {
        shortfall: liabilities - droppedReserve,
        recoveryAmount,
        fromRatio: 95,
        toRatio: 105,
        feedDescription: feedDesc,
        mechanism: 'darkpool',
      },
    })

    if (!agentMetrics) {
      agentMetrics = {
        totalRecoveries: 0, successfulRecoveries: 0, failedRecoveries: 0,
        successRate: 0, avgResponseTimeMs: 0, uptimeSeconds: 60,
        errorCount: 0, recentErrors: [],
      }
    }

    agentMetrics.totalRecoveries++
    agentMetrics.failedRecoveries++
    agentMetrics.errorCount++
    agentMetrics.successRate = (agentMetrics.successfulRecoveries / agentMetrics.totalRecoveries) * 100
    agentMetrics.recentErrors.push({
      step: 'monitorFill',
      error: 'CCC enclave matching timed out',
      timestamp: now,
    })

    if (agentMetrics.recentErrors.length > 10) {
      agentMetrics.recentErrors = agentMetrics.recentErrors.slice(-10)
    }

    // Log agent activity
    agentActivity.push({
      action: 'recovery',
      timestamp: Math.floor(now / 1000),
      details: `CCC dark pool recovery FAILED. CCC enclave matching timed out for ${fmtRecovery} wBTC (${fmtUsd}). Manual intervention required.`,
    })

    res.json({
      ok: true,
      phase: 'failed',
      mechanism: 'darkpool',
      data: {
        totalReserve: droppedReserve,
        totalLiabilities: liabilities,
        failedStep: 'CCC Enclave Match',
        error: 'CCC enclave matching timed out',
        feedDescription: feedDesc,
      },
    })
  } catch (err) {
    console.error('[simulate-failure] Error:', err)
    res.status(500).json({ error: 'Failed to simulate recovery failure' })
  }
})

// POST /api/reset — clear simulation overrides and restore normal state
app.post('/api/reset', (_req, res) => {
  overrideReserves = null
  overrideAttestation = null
  res.json({ ok: true })
})

// POST /api/toggle-reserves — proxy to mock API toggle endpoint
app.post('/api/toggle-reserves', async (_req, res) => {
  try {
    const apiRes = await fetch(`${API_URL}/toggle`, { method: 'POST' })
    if (!apiRes.ok) throw new Error('Mock API returned ' + apiRes.status)
    const data = await apiRes.json()
    res.json(data)
  } catch (err: any) {
    console.error('[dashboard] Toggle reserves failed:', err)
    res.status(500).json({ error: err.message || 'Failed to toggle reserves' })
  }
})

// Background event poller (handles dynamic CONTRACT_ADDRESS)
async function pollEvents() {
  let lastBlock = 0n
  let client: ReturnType<typeof createPublicClient> | null = null

  while (true) {
    try {
      if (CONTRACT_ADDRESS) {
        if (!client) {
          client = createPublicClient({ chain: hardhat, transport: http(RPC_URL) })
          lastBlock = 0n
        }

        const currentBlock = await client.getBlockNumber()

        if (currentBlock > lastBlock) {
          const logs = await client.getContractEvents({
            address: CONTRACT_ADDRESS,
            abi: ReserveAttestation,
            eventName: 'ReserveStatusUpdated',
            fromBlock: lastBlock + 1n,
            toBlock: currentBlock,
          })

          for (const log of logs) {
            const args = (log as any).args
            if (args) {
              const isSolvent = args.isSolvent as boolean
              const timestamp = Number(args.timestamp as bigint)

              events.push({
                isSolvent,
                timestamp,
                blockNumber: Number(log.blockNumber),
              })

              if (!isSolvent) {
                await alertManager.sendAlert(
                  'UNDERCOLLATERALIZATION',
                  `Reserve became undercollateralized at block ${log.blockNumber}`,
                  { timestamp, blockNumber: Number(log.blockNumber) }
                )
              }
            }
          }

          lastBlock = currentBlock
        }
      } else {
        client = null
      }
    } catch {}

    await new Promise(resolve => setTimeout(resolve, 2000))
  }
}

// In Vercel serverless mode, don't start the server or background tasks
if (!process.env.VERCEL) {
  const server = app.listen(PORT, BIND_HOST, () => {
    console.log(`[dashboard] Server listening on ${BIND_HOST}:${PORT}`)
    if (BIND_HOST === '127.0.0.1') {
      console.log(`[dashboard] Access via Nginx: http://${PUBLIC_URL}/cre`)
    } else {
      console.log(`[dashboard] Direct access: http://${PUBLIC_URL}:${PORT}`)
    }

    // Start background tasks
    pollEvents()

    console.log('[dashboard] Background event polling started')
    console.log(`[dashboard] Chainlink PoR feed: ${CHAINLINK_FEED_ADDRESS}`)
    console.log(`[dashboard] Chainlink RPC: ${CHAINLINK_RPC}`)
    console.log(`[dashboard] Alerts: ${alertManager.getConfig().enabled ? 'enabled' : 'disabled'}`)
  })

  process.on('SIGTERM', () => { server.close() })
  process.on('SIGINT', () => { server.close() })
}

export { app }
