import type { AgentConfig } from './config'
import { checkBalance, tradeEthToUsdc, sendUsdc } from './wallet'

export async function executeRecovery(config: AgentConfig): Promise<void> {
  console.log('[recovery] Reserve undercollateralized — initiating recovery...')

  // Step 1: Check wallet balance
  console.log('[recovery] Step 1: Checking wallet balance...')
  const balance = checkBalance(config.dryRun)
  if (!balance.success) {
    console.error('[recovery] Failed to check balance:', balance.error)
    return
  }
  console.log('[recovery] Balance:', JSON.stringify(balance.data))

  // Step 2: Trade ETH → USDC
  console.log('[recovery] Step 2: Trading ETH for USDC...')
  const trade = tradeEthToUsdc('0.01', config.dryRun)
  if (!trade.success) {
    console.error('[recovery] Trade failed:', trade.error)
    return
  }
  console.log('[recovery] Trade result:', JSON.stringify(trade.data))

  // Step 3: Send USDC to reserve address
  console.log('[recovery] Step 3: Sending USDC to reserve...')
  const send = sendUsdc('10', config.reserveAddress, config.dryRun)
  if (!send.success) {
    console.error('[recovery] Send failed:', send.error)
    return
  }
  console.log('[recovery] Send result:', JSON.stringify(send.data))

  console.log('[recovery] Recovery sequence complete.')
}
