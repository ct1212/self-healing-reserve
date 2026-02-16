import express from 'express'
import path from 'path'
import { fileURLToPath } from 'url'
import { spawn, execSync, type ChildProcess } from 'child_process'
import { createPublicClient, http, formatUnits } from 'viem'
import { hardhat, mainnet } from 'viem/chains'
import { ReserveAttestation } from '../contracts/abi/ReserveAttestation'
import { ChainlinkAggregator } from '../contracts/abi/ChainlinkAggregator'
import { deployContract } from '../demo/deploy-contract'
import { HealthMonitor } from './health'
import { AlertManager } from './alerts'

const app = express()
app.use(express.json())

const RPC_URL = process.env.RPC_URL || 'http://127.0.0.1:8545'
const API_URL = process.env.MOCK_API_URL || 'http://127.0.0.1:3001'
let CONTRACT_ADDRESS = process.env.CONTRACT_ADDRESS as `0x${string}` | undefined
const PORT = process.env.DASHBOARD_PORT || 3002
const PUBLIC_URL = process.env.PUBLIC_URL || process.env.VPS_IP || '76.13.177.213'
const BIND_HOST = process.env.BIND_HOST || '127.0.0.1' // Localhost only for production security

// Chainlink PoR feed config
const CHAINLINK_FEED_ADDRESS = (process.env.CHAINLINK_FEED_ADDRESS || '0xAd410E655C0fE4741F573152592eeb766e686CE7') as `0x${string}`
const CHAINLINK_RPC = process.env.CHAINLINK_RPC || 'https://ethereum-rpc.publicnode.com'
const EXPECTED_RESERVES_MULTIPLIER = Number(process.env.EXPECTED_RESERVES_MULTIPLIER || '0.95')

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

// Initialize health monitor and alerts
const healthMonitor = new HealthMonitor(API_URL, RPC_URL, CHAINLINK_FEED_ADDRESS, CHAINLINK_RPC)
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

// Track last agent report time for health monitoring
let lastAgentReportTime: number | null = null
let agentDownAlertSent = false

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
      health: healthMonitor.getHealth(),
      alerts: {
        config: alertManager.getConfig(),
        recent: alertManager.getHistory(10),
      },
      services: getServicesStatus(),
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

      // Record agent report for health monitoring
      const agentStartTime = Date.now() - (metrics.uptimeSeconds * 1000)
      healthMonitor.recordAgentReport(agentStartTime)
      lastAgentReportTime = Date.now()
      agentDownAlertSent = false
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

// GET /api/health — health check endpoint
app.get('/api/health', (_req, res) => {
  const isHealthy = healthMonitor.isHealthy()
  res.status(isHealthy ? 200 : 503).json({
    healthy: isHealthy,
    status: healthMonitor.getHealth(),
  })
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
      'HEALTH_CHECK_FAILURE',
      'This is a test alert from the Self-Healing Reserve dashboard',
      { test: true, timestamp: Date.now() }
    )
    res.json({ ok: true, message: 'Test alert sent to all enabled channels' })
  } catch (err) {
    res.status(500).json({ error: 'Failed to send test alert' })
  }
})

// POST /api/simulate - Simulate a recovery scenario
// Snapshots real Chainlink data, drops ratio to 95%, then recovers to 105%
app.post('/api/simulate', async (_req, res) => {
  try {
    const now = Date.now()

    // Snapshot real Chainlink data
    const cl = await fetchChainlinkData()
    const realReserve = Number(cl.answer)
    const feedDesc = cl.description

    // Math: normal liabilities = realReserve * 0.95 (so normal ratio ≈ 105%)
    const liabilities = realReserve * EXPECTED_RESERVES_MULTIPLIER
    // Drop reserve to 95% of liabilities
    const droppedReserve = liabilities * 0.95
    // Recovery target: 105% collateralization
    const targetReserve = liabilities * 1.05
    const recoveryAmount = targetReserve - droppedReserve

    // Set override to insolvent (expires after 10s as safety net)
    overrideReserves = {
      totalReserve: droppedReserve,
      totalLiabilities: liabilities,
      isSolvent: false,
      expiresAt: now + 10_000,
    }

    // Also override attestation status to match
    overrideAttestation = {
      isSolvent: false,
      expiresAt: now + 10_000,
    }

    // Record undercollateralization event
    events.push({
      isSolvent: false,
      timestamp: Math.floor(now / 1000),
      blockNumber: events.length + 1,
    })

    const ratio = Math.round((droppedReserve / liabilities) * 100)

    // Respond immediately so frontend can show insolvent state
    res.json({
      ok: true,
      phase: 'undercollateralized',
      data: {
        totalReserve: droppedReserve,
        totalLiabilities: liabilities,
        ratio,
        feedDescription: feedDesc,
      },
    })

    // After 3 seconds, trigger recovery
    setTimeout(async () => {
      try {
        // Clear overrides — reverts to Chainlink data + real contract
        overrideReserves = null
        overrideAttestation = null

        const recoveryTime = Date.now()

        // Record recovery steps with real amounts
        const fmtRecovery = recoveryAmount.toLocaleString('en-US', { maximumFractionDigits: 2 })
        const recoverySteps = [
          { step: 'checkBalance' as const, success: true, timestamp: recoveryTime, durationMs: 50,
            data: { balance: '$2,500,000,000 in USDC available in wallet' } },
          { step: 'trade' as const, success: true, timestamp: recoveryTime + 100, durationMs: 150,
            data: { amount: 'Swapped USDC → ' + fmtRecovery + ' stETH on Uniswap' } },
          { step: 'send' as const, success: true, timestamp: recoveryTime + 300, durationMs: 100,
            data: { amount: fmtRecovery + ' stETH sent to stETH reserve', tx: '0x' + Math.random().toString(16).slice(2, 10) + '...' } },
        ]

        recoveryHistory.push({
          timestamp: recoveryTime,
          success: true,
          durationMs: 300,
          steps: recoverySteps,
          summary: {
            shortfall: liabilities - droppedReserve,
            recoveryAmount,
            fromRatio: 95,
            toRatio: 105,
            feedDescription: feedDesc,
          },
        })

        // Record solvent event
        events.push({
          isSolvent: true,
          timestamp: Math.floor(recoveryTime / 1000),
          blockNumber: events.length + 1,
        })

        // Update agent metrics
        if (!agentMetrics) {
          agentMetrics = {
            totalRecoveries: 0,
            successfulRecoveries: 0,
            failedRecoveries: 0,
            successRate: 0,
            avgResponseTimeMs: 0,
            uptimeSeconds: 60,
            errorCount: 0,
            recentErrors: [],
          }
        }

        agentMetrics.totalRecoveries++
        agentMetrics.successfulRecoveries++
        agentMetrics.successRate = (agentMetrics.successfulRecoveries / agentMetrics.totalRecoveries) * 100
        agentMetrics.avgResponseTimeMs = ((agentMetrics.avgResponseTimeMs * (agentMetrics.totalRecoveries - 1)) + 300) / agentMetrics.totalRecoveries
        healthMonitor.recordAgentReport(recoveryTime - 60000)
      } catch (err) {
        console.error('[simulate] Recovery phase failed:', err)
      }
    }, 3000)
  } catch (err) {
    console.error('[simulate] Error:', err)
    res.status(500).json({ error: 'Failed to simulate recovery' })
  }
})

// POST /api/simulate-failure - Simulate a failed recovery scenario
// Snapshots real Chainlink data, drops ratio to 95%, recovery fails
app.post('/api/simulate-failure', async (_req, res) => {
  try {
    const now = Date.now()

    // Snapshot real Chainlink data
    const cl = await fetchChainlinkData()
    const realReserve = Number(cl.answer)
    const feedDesc = cl.description

    // Same math as simulate
    const liabilities = realReserve * EXPECTED_RESERVES_MULTIPLIER
    const droppedReserve = liabilities * 0.95
    const targetReserve = liabilities * 1.05
    const recoveryAmount = targetReserve - droppedReserve

    // Set override to insolvent (expires after 15s)
    overrideReserves = {
      totalReserve: droppedReserve,
      totalLiabilities: liabilities,
      isSolvent: false,
      expiresAt: now + 15_000,
    }

    // Also override attestation status to match
    overrideAttestation = {
      isSolvent: false,
      expiresAt: now + 15_000,
    }

    // Record undercollateralization event
    events.push({
      isSolvent: false,
      timestamp: Math.floor(now / 1000),
      blockNumber: events.length + 1,
    })

    // Record failed recovery steps with real amounts
    const fmtRecovery = recoveryAmount.toLocaleString('en-US', { maximumFractionDigits: 2 })
    const recoverySteps = [
      { step: 'checkBalance' as const, success: true, timestamp: now, durationMs: 50,
        data: { balance: '$2,500,000,000 in USDC available in wallet' } },
      { step: 'trade' as const, success: false, timestamp: now + 100, durationMs: 200,
        data: { error: 'Uniswap USDC→stETH swap failed — needed ' + fmtRecovery + ' stETH but pool depth insufficient' } },
      { step: 'send' as const, success: false, timestamp: now + 300, durationMs: 0,
        data: { error: 'Skipped — previous step failed' } },
    ]

    recoveryHistory.push({
      timestamp: now,
      success: false,
      durationMs: 250,
      steps: recoverySteps,
      summary: {
        shortfall: liabilities - droppedReserve,
        recoveryAmount,
        fromRatio: 95,
        toRatio: 105,
        feedDescription: feedDesc,
      },
    })

    // Update agent metrics
    if (!agentMetrics) {
      agentMetrics = {
        totalRecoveries: 0,
        successfulRecoveries: 0,
        failedRecoveries: 0,
        successRate: 0,
        avgResponseTimeMs: 0,
        uptimeSeconds: 60,
        errorCount: 0,
        recentErrors: [],
      }
    }

    agentMetrics.totalRecoveries++
    agentMetrics.failedRecoveries++
    agentMetrics.errorCount++
    agentMetrics.successRate = (agentMetrics.successfulRecoveries / agentMetrics.totalRecoveries) * 100
    agentMetrics.recentErrors.push({
      step: 'trade',
      error: 'Insufficient liquidity in pool',
      timestamp: now,
    })

    if (agentMetrics.recentErrors.length > 10) {
      agentMetrics.recentErrors = agentMetrics.recentErrors.slice(-10)
    }

    healthMonitor.recordAgentReport(now - 60000)

    // Stays insolvent — override expires after 15s
    res.json({
      ok: true,
      phase: 'failed',
      data: {
        totalReserve: droppedReserve,
        totalLiabilities: liabilities,
        failedStep: 'Execute Trade',
        error: 'Insufficient liquidity in pool',
        feedDescription: feedDesc,
      },
    })
  } catch (err) {
    console.error('[simulate-failure] Error:', err)
    res.status(500).json({ error: 'Failed to simulate recovery failure' })
  }
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

// ── Service process management ──────────────────────────────────────────
const PROJECT_ROOT = path.resolve(__dirname, '..')
const serviceProcs: Map<string, ChildProcess> = new Map()
let servicesStarting = false

function isServiceRunning(name: string): boolean {
  const proc = serviceProcs.get(name)
  return proc != null && proc.exitCode === null
}

function stopAllServices() {
  for (const [, proc] of serviceProcs) {
    try { proc.kill('SIGTERM') } catch {}
  }
  serviceProcs.clear()
}

function freePort(port: number) {
  try {
    execSync(`fuser -k ${port}/tcp 2>/dev/null`, { stdio: 'ignore' })
  } catch {}
}

function waitForService(url: string, timeoutMs = 20000): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now()
    const check = async () => {
      try {
        const isRpc = url.includes('8545')
        const res = isRpc
          ? await fetch(url, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ jsonrpc: '2.0', method: 'eth_blockNumber', params: [], id: 1 }),
            })
          : await fetch(url)
        if (res.ok) return resolve()
      } catch {}
      if (Date.now() - start > timeoutMs) return reject(new Error(`Timed out waiting for ${url}`))
      setTimeout(check, 500)
    }
    check()
  })
}

function getServicesStatus() {
  return {
    starting: servicesStarting,
    hardhat: isServiceRunning('hardhat'),
    mockApi: isServiceRunning('mock-api'),
    agent: isServiceRunning('agent'),
    contractAddress: CONTRACT_ADDRESS || null,
  }
}

// POST /api/start-services — start Hardhat, deploy contract, start mock-api & agent
app.post('/api/start-services', async (_req, res) => {
  if (servicesStarting) return res.status(409).json({ error: 'Services are already starting' })
  if (isServiceRunning('hardhat')) return res.status(409).json({ error: 'Services are already running. Stop them first.' })

  servicesStarting = true
  const steps: string[] = []

  try {
    // Free ports
    freePort(8545)
    freePort(3001)
    await new Promise(r => setTimeout(r, 500))

    // 1. Start Hardhat
    steps.push('Starting Hardhat node...')
    const hardhatProc = spawn('npx', ['hardhat', 'node'], {
      cwd: PROJECT_ROOT,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    serviceProcs.set('hardhat', hardhatProc)
    hardhatProc.on('exit', () => serviceProcs.delete('hardhat'))
    await waitForService('http://127.0.0.1:8545')
    steps.push('Hardhat node ready')

    // 2. Deploy contract
    steps.push('Deploying contract...')
    const addr = await deployContract('http://127.0.0.1:8545')
    CONTRACT_ADDRESS = addr
    process.env.CONTRACT_ADDRESS = addr
    steps.push(`Contract deployed: ${addr}`)

    // 3. Start mock API
    steps.push('Starting mock API...')
    const mockProc = spawn('npx', ['tsx', 'mock-api/server.ts'], {
      cwd: PROJECT_ROOT,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    serviceProcs.set('mock-api', mockProc)
    mockProc.on('exit', () => serviceProcs.delete('mock-api'))
    await waitForService('http://127.0.0.1:3001/state')
    steps.push('Mock API ready')

    // 4. Start agent
    steps.push('Starting agent...')
    const agentProc = spawn('npx', ['tsx', 'agent/index.ts'], {
      cwd: PROJECT_ROOT,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        AWAL_DRY_RUN: 'true',
        CONTRACT_ADDRESS: addr,
        RPC_URL: RPC_URL,
      },
    })
    serviceProcs.set('agent', agentProc)
    agentProc.on('exit', () => serviceProcs.delete('agent'))
    steps.push('Agent started')

    console.log('[dashboard] All services started. Contract:', addr)
    res.json({ ok: true, steps, contractAddress: addr })
  } catch (err: any) {
    console.error('[dashboard] Failed to start services:', err)
    stopAllServices()
    res.status(500).json({ error: err.message, steps })
  } finally {
    servicesStarting = false
  }
})

// POST /api/stop-services — stop all managed services
app.post('/api/stop-services', (_req, res) => {
  stopAllServices()
  freePort(8545)
  freePort(3001)
  console.log('[dashboard] All services stopped')
  res.json({ ok: true })
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

// Background agent health monitor
async function monitorAgentHealth() {
  const AGENT_TIMEOUT = 5 * 60 * 1000 // 5 minutes

  while (true) {
    await new Promise(resolve => setTimeout(resolve, 30000)) // Check every 30s

    if (lastAgentReportTime) {
      const timeSinceReport = Date.now() - lastAgentReportTime

      if (timeSinceReport > AGENT_TIMEOUT && !agentDownAlertSent) {
        await alertManager.sendAlert(
          'AGENT_DOWN',
          `Agent has not reported for ${Math.floor(timeSinceReport / 60000)} minutes`,
          { lastReport: lastAgentReportTime }
        )
        agentDownAlertSent = true
      }
    }
  }
}

// Background health check monitor
async function monitorSystemHealth() {
  let lastHealthy = true

  while (true) {
    await new Promise(resolve => setTimeout(resolve, 30000)) // Check every 30s

    const health = healthMonitor.getHealth()
    const isHealthy = healthMonitor.isHealthy()

    // Alert on transition from healthy to unhealthy
    if (lastHealthy && !isHealthy) {
      const unhealthyComponents = []
      if (!health.api.healthy) unhealthyComponents.push('API')
      if (!health.blockchain.healthy) unhealthyComponents.push('Blockchain')
      if (!health.agent.healthy) unhealthyComponents.push('Agent')

      await alertManager.sendAlert(
        'HEALTH_CHECK_FAILURE',
        `System health check failed: ${unhealthyComponents.join(', ')} unhealthy`,
        { health }
      )
    }

    lastHealthy = isHealthy
  }
}

const server = app.listen(PORT, BIND_HOST, () => {
  console.log(`[dashboard] Server listening on ${BIND_HOST}:${PORT}`)
  if (BIND_HOST === '127.0.0.1') {
    console.log(`[dashboard] Access via Nginx: http://${PUBLIC_URL}/cre`)
  } else {
    console.log(`[dashboard] Direct access: http://${PUBLIC_URL}:${PORT}`)
  }

  // Start background tasks
  healthMonitor.start()
  pollEvents()
  monitorAgentHealth()
  monitorSystemHealth()

  console.log('[dashboard] Background monitoring started')
  console.log(`[dashboard] Chainlink PoR feed: ${CHAINLINK_FEED_ADDRESS}`)
  console.log(`[dashboard] Chainlink RPC: ${CHAINLINK_RPC}`)
  console.log(`[dashboard] Alerts: ${alertManager.getConfig().enabled ? 'enabled' : 'disabled'}`)
})

process.on('SIGTERM', () => {
  stopAllServices()
  healthMonitor.stop()
  server.close()
})

process.on('SIGINT', () => {
  stopAllServices()
  healthMonitor.stop()
  server.close()
})

export { app, server }
