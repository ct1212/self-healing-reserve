import { loadConfig } from './config'
import { startMonitor } from './monitor'
import { executeRecovery } from './recovery'
import type { RecoveryResult } from './recovery'
import { MetricsCollector } from './metrics'
import type { MetricsSummary } from './metrics'

const metricsCollector = new MetricsCollector()

async function reportToDashboard(
  config: ReturnType<typeof loadConfig>,
  metrics: MetricsSummary,
  recoveryResult: RecoveryResult
): Promise<void> {
  if (!config.reportingEnabled) {
    return
  }

  try {
    const response = await fetch(`${config.dashboardUrl}/api/agent-activity`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        timestamp: Date.now(),
        metrics,
        recovery: recoveryResult,
      }),
    })

    if (!response.ok) {
      console.error(`[agent] Dashboard reporting failed: ${response.status} ${response.statusText}`)
    }
  } catch (error) {
    console.error('[agent] Failed to report to dashboard:', error instanceof Error ? error.message : String(error))
  }
}

async function main() {
  const config = loadConfig()

  console.log('[agent] Starting Self-Healing Reserve Agent')
  console.log(`[agent] Contract: ${config.contractAddress}`)
  console.log(`[agent] RPC: ${config.rpcUrl}`)
  console.log(`[agent] Dry-run: ${config.dryRun}`)
  console.log(`[agent] Dashboard reporting: ${config.reportingEnabled ? 'enabled' : 'disabled'}`)

  let recovering = false

  const stop = startMonitor(config, async (isSolvent, timestamp) => {
    console.log(
      `[agent] ReserveStatusUpdated: isSolvent=${isSolvent}, timestamp=${timestamp}`
    )

    if (!isSolvent && !recovering) {
      recovering = true
      metricsCollector.recordRecoveryStart()
      const startTime = Date.now()

      try {
        const result = await executeRecovery(config)
        const durationMs = Date.now() - startTime

        if (result.success) {
          metricsCollector.recordRecoverySuccess(durationMs)
          console.log(`[agent] Recovery succeeded in ${durationMs}ms`)
        } else {
          const failedStep = result.steps.find(s => !s.success)
          metricsCollector.recordRecoveryFailure(
            failedStep?.step || 'unknown',
            failedStep?.error || 'Unknown error',
            durationMs,
            { steps: result.steps }
          )
          console.error(`[agent] Recovery failed in ${durationMs}ms`)
        }

        // Report to dashboard
        const metrics = metricsCollector.getMetrics()
        await reportToDashboard(config, metrics, result)
      } catch (error) {
        const durationMs = Date.now() - startTime
        const errorMessage = error instanceof Error ? error.message : String(error)
        metricsCollector.recordRecoveryFailure('exception', errorMessage, durationMs)
        console.error('[agent] Recovery exception:', errorMessage)

        // Report error to dashboard
        const metrics = metricsCollector.getMetrics()
        await reportToDashboard(config, metrics, {
          success: false,
          steps: [],
          durationMs,
        })
      } finally {
        recovering = false
      }
    } else if (isSolvent) {
      console.log('[agent] Reserves healthy, no action needed.')
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
