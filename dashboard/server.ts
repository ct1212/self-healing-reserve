import express from 'express'
import path from 'path'
import { fileURLToPath } from 'url'
import { createPublicClient, http } from 'viem'
import { hardhat } from 'viem/chains'
import { ReserveAttestation } from '../contracts/abi/ReserveAttestation'

const app = express()
app.use(express.json())

const RPC_URL = process.env.RPC_URL || 'http://127.0.0.1:8545'
const API_URL = process.env.MOCK_API_URL || 'http://127.0.0.1:3001'
const CONTRACT_ADDRESS = process.env.CONTRACT_ADDRESS as `0x${string}` | undefined
const PORT = process.env.DASHBOARD_PORT || 3002

// Serve static files
const __dirname = path.dirname(fileURLToPath(import.meta.url))
app.use(express.static(path.join(__dirname, 'public')))

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

// GET /api/status — aggregated dashboard data
app.get('/api/status', async (_req, res) => {
  try {
    // Fetch mock-api reserves
    let reserves = { totalReserve: 0, totalLiabilities: 0, isSolvent: true }
    try {
      const apiRes = await fetch(`${API_URL}/reserves`)
      if (apiRes.ok) reserves = await apiRes.json()
    } catch {}

    // Read contract state
    let contract = { isSolvent: true, lastUpdated: 0 }
    if (CONTRACT_ADDRESS) {
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

    res.json({
      reserves,
      contract,
      events,
      agent: {
        activities: agentActivity,
        recoveryCount: agentActivity.filter(a => a.action === 'recovery').length,
      },
    })
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch status' })
  }
})

// POST /api/agent-activity — agent reports actions here
app.post('/api/agent-activity', (req, res) => {
  const { action, details } = req.body
  agentActivity.push({
    action: action || 'unknown',
    timestamp: Math.floor(Date.now() / 1000),
    details,
  })
  res.json({ ok: true })
})

// Background event poller
async function pollEvents() {
  if (!CONTRACT_ADDRESS) return

  const client = createPublicClient({
    chain: hardhat,
    transport: http(RPC_URL),
  })

  let lastBlock = 0n

  while (true) {
    try {
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
            events.push({
              isSolvent: args.isSolvent as boolean,
              timestamp: Number(args.timestamp as bigint),
              blockNumber: Number(log.blockNumber),
            })
          }
        }

        lastBlock = currentBlock
      }
    } catch {}

    await new Promise(resolve => setTimeout(resolve, 2000))
  }
}

const server = app.listen(PORT, () => {
  console.log(`[dashboard] Live dashboard at http://127.0.0.1:${PORT}`)
  pollEvents()
})

process.on('SIGTERM', () => server.close())
process.on('SIGINT', () => server.close())

export { app, server }
