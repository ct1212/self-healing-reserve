import { execSync } from 'child_process'

export interface WalletResult {
  success: boolean
  data?: unknown
  error?: string
}

function runAwal(args: string, dryRun: boolean): WalletResult {
  const cmd = `npx awal@latest ${args} --json`

  if (dryRun) {
    console.log(`[wallet] DRY-RUN: ${cmd}`)
    return { success: true, data: { dryRun: true, command: cmd } }
  }

  try {
    const output = execSync(cmd, {
      encoding: 'utf-8',
      timeout: 30_000,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    const data = JSON.parse(output)
    return { success: true, data }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err)
    console.error(`[wallet] Command failed: ${cmd}`, message)
    return { success: false, error: message }
  }
}

export function checkBalance(dryRun: boolean): WalletResult {
  return runAwal('balance', dryRun)
}

export function tradeEthToUsdc(amount: string, dryRun: boolean): WalletResult {
  return runAwal(`trade ${amount} eth usdc`, dryRun)
}

export function sendUsdc(amount: string, recipient: string, dryRun: boolean): WalletResult {
  return runAwal(`send ${amount} ${recipient}`, dryRun)
}

export function walletStatus(dryRun: boolean): WalletResult {
  return runAwal('status', dryRun)
}
