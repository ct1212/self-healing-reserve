export interface AgentConfig {
  rpcUrl: string
  contractAddress: `0x${string}`
  reserveAddress: `0x${string}`
  dryRun: boolean
  pollInterval: number
  dashboardUrl: string
  reportingEnabled: boolean
}

export function loadConfig(): AgentConfig {
  const contractAddress = process.env.CONTRACT_ADDRESS
  if (!contractAddress) {
    throw new Error('CONTRACT_ADDRESS env var is required')
  }

  return {
    rpcUrl: process.env.RPC_URL || 'http://127.0.0.1:8545',
    contractAddress: contractAddress as `0x${string}`,
    reserveAddress: (process.env.RESERVE_ADDRESS || '0x0000000000000000000000000000000000000000') as `0x${string}`,
    dryRun: process.env.AWAL_DRY_RUN !== 'false',
    pollInterval: Number(process.env.POLL_INTERVAL) || 2000,
    dashboardUrl: process.env.DASHBOARD_URL || 'http://127.0.0.1:3002',
    reportingEnabled: process.env.REPORTING_ENABLED !== 'false',
  }
}
