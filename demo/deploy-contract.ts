import { execSync } from 'child_process'
import { createPublicClient, createWalletClient, http } from 'viem'
import { hardhat } from 'viem/chains'
import { mnemonicToAccount } from 'viem/accounts'
import * as fs from 'fs'
import * as path from 'path'

// Hardhat's default mnemonic
const HARDHAT_MNEMONIC = 'test test test test test test test test test test test junk'

interface CompileResult {
  abi: unknown[]
  bytecode: `0x${string}`
}

function compileSolidity(): CompileResult {
  const contractPath = path.resolve(__dirname, '../contracts/src/ReserveAttestation.sol')
  const source = fs.readFileSync(contractPath, 'utf-8')

  const input = JSON.stringify({
    language: 'Solidity',
    sources: {
      'ReserveAttestation.sol': { content: source },
    },
    settings: {
      outputSelection: {
        '*': {
          '*': ['abi', 'evm.bytecode.object'],
        },
      },
    },
  })

  const raw = execSync(`npx solc --standard-json`, {
    input,
    encoding: 'utf-8',
    maxBuffer: 10 * 1024 * 1024,
  })

  // solc may print non-JSON lines (e.g. SMT warnings) before the JSON output
  const jsonStart = raw.indexOf('{')
  if (jsonStart === -1) throw new Error('No JSON output from solc')
  const compiled = JSON.parse(raw.slice(jsonStart))

  if (compiled.errors?.some((e: any) => e.severity === 'error')) {
    const errors = compiled.errors.filter((e: any) => e.severity === 'error')
    throw new Error(`Solidity compilation errors:\n${errors.map((e: any) => e.formattedMessage).join('\n')}`)
  }

  const contract = compiled.contracts['ReserveAttestation.sol']['ReserveAttestation']
  return {
    abi: contract.abi,
    bytecode: `0x${contract.evm.bytecode.object}` as `0x${string}`,
  }
}

export async function deployContract(rpcUrl = 'http://127.0.0.1:8545'): Promise<`0x${string}`> {
  console.log('[deploy] Compiling ReserveAttestation.sol...')
  const { abi, bytecode } = compileSolidity()
  console.log('[deploy] Compilation successful.')

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

  console.log(`[deploy] Deploying from ${account.address}...`)

  const hash = await walletClient.deployContract({
    abi,
    bytecode,
  })

  const receipt = await publicClient.waitForTransactionReceipt({ hash })

  if (!receipt.contractAddress) {
    throw new Error('Deployment failed: no contract address in receipt')
  }

  console.log(`[deploy] Contract deployed at: ${receipt.contractAddress}`)
  return receipt.contractAddress as `0x${string}`
}

// Run standalone
if (require.main === module) {
  const rpcUrl = process.env.RPC_URL || 'http://127.0.0.1:8545'
  deployContract(rpcUrl)
    .then(addr => console.log(`CONTRACT_ADDRESS=${addr}`))
    .catch(err => {
      console.error(err)
      process.exit(1)
    })
}
