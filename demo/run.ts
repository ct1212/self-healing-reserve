import { execSync, spawn, type ChildProcess } from 'child_process'
import { deployContract } from './deploy-contract'
import { simulateWorkflow } from './simulate-workflow'

const RPC_URL = 'http://127.0.0.1:8545'
const API_URL = 'http://127.0.0.1:3001'
const DASHBOARD_URL = 'http://127.0.0.1:3002'

const children: ChildProcess[] = []

function cleanup() {
  for (const child of children) {
    child.kill('SIGTERM')
  }
}

function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/** Kill any process holding a given port */
function freePort(port: number) {
  try {
    execSync(`lsof -ti:${port} | xargs kill -9 2>/dev/null`, { stdio: 'ignore' })
  } catch {}
}

/** Strip ANSI escape codes */
function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;]*m/g, '')
}

function waitForReady(url: string, label: string, timeoutMs = 15000): Promise<void> {
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
        if (res.ok) {
          console.log(`[demo] ${label} is ready.`)
          return resolve()
        }
      } catch {}
      if (Date.now() - start > timeoutMs) {
        return reject(new Error(`${label} did not start within ${timeoutMs}ms`))
      }
      setTimeout(check, 500)
    }
    check()
  })
}

/** Lines to suppress from Hardhat output */
const HARDHAT_NOISE = [
  'Account #',
  'Private Key:',
  'WARNING: These accounts',
  'Any funds sent to them',
  'Accounts',
  '========',
  'eth_fillTransaction',
  'eth_getTransactionCount',
  'eth_getBlockByNumber',
  'eth_maxPriorityFeePerGas',
  'eth_estimateGas',
  'eth_sendRawTransaction',
  'eth_getTransactionReceipt',
  'eth_blockNumber',
  'eth_getLogs',
  'eth_call',
  'eth_accounts',
]

function isNoisyLine(label: string, line: string): boolean {
  if (label !== 'hardhat') return false
  return HARDHAT_NOISE.some(noise => line.includes(noise))
}

function startProcess(cmd: string, args: string[], label: string): ChildProcess {
  const child = spawn(cmd, args, {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env },
  })
  children.push(child)

  const handleOutput = (data: Buffer) => {
    for (const raw of data.toString().split('\n').filter(Boolean)) {
      const line = stripAnsi(raw)
      if (isNoisyLine(label, line)) continue
      console.log(`  ${label} | ${line}`)
    }
  }

  child.stdout?.on('data', handleOutput)
  child.stderr?.on('data', handleOutput)

  return child
}

async function main() {
  console.log('='.repeat(60))
  console.log('  Self-Healing Reserve — End-to-End Demo')
  console.log('='.repeat(60))
  console.log()

  // Free ports from any stale processes
  freePort(8545)
  freePort(3001)
  freePort(3002)
  await sleep(500)

  // Step 1: Start Hardhat node
  console.log('[demo] Step 1: Starting Hardhat node...')
  startProcess('npx', ['hardhat', 'node'], 'hardhat')
  await waitForReady(`${RPC_URL}`, 'Hardhat node')
  await sleep(1000)

  // Step 2: Deploy contract
  console.log('\n[demo] Step 2: Deploying ReserveAttestation contract...')
  const contractAddress = await deployContract(RPC_URL)

  // Step 3: Start mock API
  console.log('\n[demo] Step 3: Starting mock API server...')
  startProcess('npx', ['tsx', 'mock-api/server.ts'], 'mock-api')
  await waitForReady(`${API_URL}/state`, 'Mock API')

  // Step 4: Start dashboard
  console.log('\n[demo] Step 4: Starting live dashboard...')
  process.env.CONTRACT_ADDRESS = contractAddress
  process.env.RPC_URL = RPC_URL
  startProcess('npx', ['tsx', 'dashboard/server.ts'], 'dashboard')
  await waitForReady(`${DASHBOARD_URL}/api/status`, 'Dashboard')

  // Step 5: Start agent (set env before spawning)
  console.log('\n[demo] Step 5: Starting recovery agent...')
  process.env.AWAL_DRY_RUN = 'true'
  startProcess('npx', ['tsx', 'agent/index.ts'], 'agent')
  await sleep(2000)

  // Step 6: Simulate healthy check
  console.log('\n[demo] Step 6: Simulating HEALTHY reserve check...')
  const result1 = await simulateWorkflow(contractAddress, `${API_URL}/reserves`, RPC_URL)
  console.log(`[demo] → Attestation: isSolvent=${result1}`)
  await sleep(3000)

  // Step 7: Toggle to undercollateralized
  console.log('\n[demo] Step 7: Toggling to UNDERCOLLATERALIZED...')
  await fetch(`${API_URL}/toggle`, { method: 'POST' })
  console.log('[demo] Mock API now reporting undercollateralized.')

  // Step 8: Simulate undercollateralized check
  console.log('\n[demo] Step 8: Simulating UNDERCOLLATERALIZED reserve check...')
  const result2 = await simulateWorkflow(contractAddress, `${API_URL}/reserves`, RPC_URL)
  console.log(`[demo] → Attestation: isSolvent=${result2}`)
  await sleep(3000)

  // Step 9: Toggle back to healthy
  console.log('\n[demo] Step 9: Toggling back to HEALTHY...')
  await fetch(`${API_URL}/toggle`, { method: 'POST' })

  // Step 10: Simulate recovery confirmation
  console.log('\n[demo] Step 10: Simulating RECOVERY confirmation check...')
  const result3 = await simulateWorkflow(contractAddress, `${API_URL}/reserves`, RPC_URL)
  console.log(`[demo] → Attestation: isSolvent=${result3}`)
  await sleep(2000)

  // Summary
  console.log('\n' + '='.repeat(60))
  console.log('  Demo Summary')
  console.log('='.repeat(60))
  console.log(`  Contract:      ${contractAddress}`)
  console.log(`  Dashboard:     ${DASHBOARD_URL}`)
  console.log(`  Check 1:       isSolvent=${result1} (healthy → agent idle)`)
  console.log(`  Check 2:       isSolvent=${result2} (undercollateralized → agent recovers)`)
  console.log(`  Check 3:       isSolvent=${result3} (restored → agent confirms)`)
  console.log('='.repeat(60))

  cleanup()
  process.exit(0)
}

process.on('SIGTERM', cleanup)
process.on('SIGINT', cleanup)
process.on('uncaughtException', (err) => {
  console.error('[demo] Uncaught exception:', err)
  cleanup()
  process.exit(1)
})

main().catch(err => {
  console.error('[demo] Fatal error:', err)
  cleanup()
  process.exit(1)
})
