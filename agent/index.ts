import { loadConfig } from './config'
import { startMonitor } from './monitor'
import { executeRecovery } from './recovery'

async function main() {
  const config = loadConfig()

  console.log('[agent] Starting Self-Healing Reserve Agent')
  console.log(`[agent] Contract: ${config.contractAddress}`)
  console.log(`[agent] RPC: ${config.rpcUrl}`)
  console.log(`[agent] Dry-run: ${config.dryRun}`)

  let recovering = false

  const stop = startMonitor(config, async (isSolvent, timestamp) => {
    console.log(
      `[agent] ReserveStatusUpdated: isSolvent=${isSolvent}, timestamp=${timestamp}`
    )

    if (!isSolvent && !recovering) {
      recovering = true
      try {
        await executeRecovery(config)
      } finally {
        recovering = false
      }
    } else if (isSolvent) {
      console.log('[agent] Reserves healthy — no action needed.')
    }
  })

  // Graceful shutdown
  const shutdown = () => {
    console.log('[agent] Shutting down...')
    stop()
    process.exit(0)
  }

  process.on('SIGTERM', shutdown)
  process.on('SIGINT', shutdown)

  console.log('[agent] Monitoring for ReserveStatusUpdated events...')
}

main().catch((err) => {
  console.error('[agent] Fatal error:', err)
  process.exit(1)
})
