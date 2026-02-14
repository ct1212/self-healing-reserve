import { createPublicClient, http, type Log } from 'viem'
import { hardhat } from 'viem/chains'
import { ReserveAttestation } from '../contracts/abi/ReserveAttestation'
import type { AgentConfig } from './config'

export type StatusHandler = (isSolvent: boolean, timestamp: bigint) => void

export function startMonitor(config: AgentConfig, onStatus: StatusHandler): () => void {
  const client = createPublicClient({
    chain: hardhat,
    transport: http(config.rpcUrl),
  })

  let stopped = false

  const poll = async () => {
    let lastBlock = 0n

    while (!stopped) {
      try {
        const currentBlock = await client.getBlockNumber()

        if (currentBlock > lastBlock) {
          const logs = await client.getContractEvents({
            address: config.contractAddress,
            abi: ReserveAttestation,
            eventName: 'ReserveStatusUpdated',
            fromBlock: lastBlock + 1n,
            toBlock: currentBlock,
          })

          for (const log of logs) {
            const args = (log as any).args
            if (args) {
              onStatus(args.isSolvent as boolean, args.timestamp as bigint)
            }
          }

          lastBlock = currentBlock
        }
      } catch (err) {
        console.error('[monitor] Error polling events:', err)
      }

      await new Promise(resolve => setTimeout(resolve, config.pollInterval))
    }
  }

  poll()

  return () => {
    stopped = true
  }
}
