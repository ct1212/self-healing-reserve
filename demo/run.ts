import { spawn, type ChildProcess } from 'child_process'
import { deployContract } from './deploy-contract'
import { simulateWorkflow } from './simulate-workflow'

const RPC_URL = 'http://127.0.0.1:8545'
const API_URL = 'http://127.0.0.1:3001'

const children: ChildProcess[] = []

function cleanup() {
  for (const child of children) {
    child.kill('SIGTERM')
  }
}

function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function waitForReady(url: string, label: string, timeoutMs = 15000): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now()
    const check = async () => {
      try {
        // For JSON-RPC endpoints, POST a simple request; for HTTP APIs, use GET
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

function startProcess(cmd: string, args: string[], label: string): ChildProcess {
  const child = spawn(cmd, args, {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env },
  })
  children.push(child)

  child.stdout?.on('data', (data: Buffer) => {
    for (const line of data.toString().split('\n').filter(Boolean)) {
      console.log(`  ${label} | ${line}`)
    }
  })
  child.stderr?.on('data', (data: Buffer) => {
    for (const line of data.toString().split('\n').filter(Boolean)) {
      console.log(`  ${label} | ${line}`)
    }
  })

  return child
}

async function main() {
  console.log('='.repeat(60))
  console.log('  Self-Healing Reserve — End-to-End Demo')
  console.log('='.repeat(60))
  console.log()

  // Step 1: Start Hardhat node
  console.log('[demo] Step 1: Starting Hardhat node...')
  const hardhatNode = startProcess('npx', ['hardhat', 'node'], 'hardhat')
  await waitForReady(`${RPC_URL}`, 'Hardhat node')
  await sleep(1000) // extra settle time

  // Step 2: Deploy contract
  console.log('\n[demo] Step 2: Deploying ReserveAttestation contract...')
  const contractAddress = await deployContract(RPC_URL)

  // Step 3: Start mock API
  console.log('\n[demo] Step 3: Starting mock API server...')
  startProcess('npx', ['tsx', 'mock-api/server.ts'], 'mock-api')
  await waitForReady(`${API_URL}/state`, 'Mock API')

  // Step 4: Start agent (set env before spawning)
  console.log('\n[demo] Step 4: Starting recovery agent...')
  process.env.CONTRACT_ADDRESS = contractAddress
  process.env.RPC_URL = RPC_URL
  process.env.AWAL_DRY_RUN = 'true'
  startProcess('npx', ['tsx', 'agent/index.ts'], 'agent')
  await sleep(2000) // let agent start polling

  // Step 5: Simulate healthy check
  console.log('\n[demo] Step 5: Simulating HEALTHY reserve check...')
  const result1 = await simulateWorkflow(contractAddress, `${API_URL}/reserves`, RPC_URL)
  console.log(`[demo] → Attestation: isSolvent=${result1}`)
  await sleep(3000) // let agent process event

  // Step 6: Toggle to undercollateralized
  console.log('\n[demo] Step 6: Toggling to UNDERCOLLATERALIZED...')
  await fetch(`${API_URL}/toggle`, { method: 'POST' })
  console.log('[demo] Mock API now reporting undercollateralized.')

  // Step 7: Simulate undercollateralized check
  console.log('\n[demo] Step 7: Simulating UNDERCOLLATERALIZED reserve check...')
  const result2 = await simulateWorkflow(contractAddress, `${API_URL}/reserves`, RPC_URL)
  console.log(`[demo] → Attestation: isSolvent=${result2}`)
  await sleep(3000) // let agent detect + recover

  // Step 8: Toggle back to healthy
  console.log('\n[demo] Step 8: Toggling back to HEALTHY...')
  await fetch(`${API_URL}/toggle`, { method: 'POST' })

  // Step 9: Simulate recovery confirmation
  console.log('\n[demo] Step 9: Simulating RECOVERY confirmation check...')
  const result3 = await simulateWorkflow(contractAddress, `${API_URL}/reserves`, RPC_URL)
  console.log(`[demo] → Attestation: isSolvent=${result3}`)
  await sleep(2000) // let agent see recovery

  // Summary
  console.log('\n' + '='.repeat(60))
  console.log('  Demo Summary')
  console.log('='.repeat(60))
  console.log(`  Contract:      ${contractAddress}`)
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
