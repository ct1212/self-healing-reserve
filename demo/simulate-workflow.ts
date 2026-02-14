import { createPublicClient, createWalletClient, http } from 'viem'
import { hardhat } from 'viem/chains'
import { mnemonicToAccount } from 'viem/accounts'
import { ReserveAttestation } from '../contracts/abi/ReserveAttestation'

const HARDHAT_MNEMONIC = 'test test test test test test test test test test test junk'

interface ReserveData {
  totalReserve: number
  totalLiabilities: number
  isSolvent: boolean
}

async function fetchReserves(apiUrl: string): Promise<ReserveData> {
  const res = await fetch(apiUrl)
  if (!res.ok) throw new Error(`API error: ${res.status}`)
  return res.json()
}

export async function simulateWorkflow(
  contractAddress: `0x${string}`,
  apiUrl = 'http://127.0.0.1:3001/reserves',
  rpcUrl = 'http://127.0.0.1:8545',
): Promise<boolean> {
  console.log('[workflow-sim] Fetching reserves from mock API...')
  const reserves = await fetchReserves(apiUrl)
  console.log(`[workflow-sim] Reserves: ${JSON.stringify(reserves)}`)

  // Simulate TEE-private comparison
  const isSolvent = reserves.totalReserve >= reserves.totalLiabilities
  console.log(`[workflow-sim] Attestation result: isSolvent=${isSolvent}`)

  // Write attestation to contract
  const account = mnemonicToAccount(HARDHAT_MNEMONIC)

  const walletClient = createWalletClient({
    account,
    chain: hardhat,
    transport: http(rpcUrl),
  })

  const publicClient = createPublicClient({
    chain: hardhat,
    transport: http(rpcUrl),
  })

  console.log('[workflow-sim] Submitting attestation to contract...')
  const hash = await walletClient.writeContract({
    address: contractAddress,
    abi: ReserveAttestation,
    functionName: 'updateAttestation',
    args: [isSolvent],
  })

  const receipt = await publicClient.waitForTransactionReceipt({ hash })
  console.log(`[workflow-sim] Transaction confirmed in block ${receipt.blockNumber}`)

  return isSolvent
}

// Run standalone
if (require.main === module) {
  const contractAddress = process.env.CONTRACT_ADDRESS as `0x${string}`
  if (!contractAddress) {
    console.error('CONTRACT_ADDRESS env var required')
    process.exit(1)
  }
  simulateWorkflow(contractAddress)
    .then(solvent => console.log(`Result: isSolvent=${solvent}`))
    .catch(err => {
      console.error(err)
      process.exit(1)
    })
}
