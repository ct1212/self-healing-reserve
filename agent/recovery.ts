import type { AgentConfig } from './config'
import { checkBalance, tradeEthToUsdc, sendUsdc } from './wallet'
import { executeDarkPoolRecovery, compareMechanisms } from './darkpool'

export interface RecoveryStep {
  step: 'checkBalance' | 'trade' | 'send';
  success: boolean;
  timestamp: number;
  durationMs?: number;
  data?: unknown;
  error?: string;
}

export interface RecoveryResult {
  success: boolean;
  steps: RecoveryStep[];
  durationMs: number;
}

export async function executeRecovery(config: AgentConfig, deficitAmount?: string): Promise<RecoveryResult> {
  console.log('[recovery] Reserve undercollateralized — initiating recovery...')

  // Choose mechanism based on deficit size
  const useDarkPool = deficitAmount && parseFloat(deficitAmount) > 10000; // >$10K use dark pool
  
  if (useDarkPool) {
    console.log('[recovery] Large deficit detected — using confidential dark pool...')
    console.log(compareMechanisms())
    
    const result = await executeDarkPoolRecovery(deficitAmount!, config)
    
    // Map dark pool result to standard RecoveryResult format
    return {
      success: result.success,
      steps: result.steps.map(s => ({
        step: s.step as 'checkBalance' | 'trade' | 'send',
        success: s.success,
        timestamp: s.timestamp,
        durationMs: s.durationMs,
        data: { ...s.data, mechanism: 'darkpool', confidential: true },
        error: s.error
      })),
      durationMs: result.durationMs
    }
  }

  const startTime = Date.now();
  const steps: RecoveryStep[] = [];

  // Step 1: Check wallet balance
  console.log('[recovery] Step 1: Checking wallet balance...')
  const step1Start = Date.now();
  const balance = checkBalance(config.dryRun)
  const step1Duration = Date.now() - step1Start;

  if (!balance.success) {
    console.error('[recovery] Failed to check balance:', balance.error)
    steps.push({
      step: 'checkBalance',
      success: false,
      timestamp: step1Start,
      durationMs: step1Duration,
      error: balance.error,
    });
    return {
      success: false,
      steps,
      durationMs: Date.now() - startTime,
    };
  }

  console.log('[recovery] Balance:', JSON.stringify(balance.data))
  steps.push({
    step: 'checkBalance',
    success: true,
    timestamp: step1Start,
    durationMs: step1Duration,
    data: balance.data,
  });

  // Step 2: Trade ETH → USDC
  console.log('[recovery] Step 2: Trading ETH for USDC...')
  const step2Start = Date.now();
  const trade = tradeEthToUsdc('0.01', config.dryRun)
  const step2Duration = Date.now() - step2Start;

  if (!trade.success) {
    console.error('[recovery] Trade failed:', trade.error)
    steps.push({
      step: 'trade',
      success: false,
      timestamp: step2Start,
      durationMs: step2Duration,
      error: trade.error,
    });
    return {
      success: false,
      steps,
      durationMs: Date.now() - startTime,
    };
  }

  console.log('[recovery] Trade result:', JSON.stringify(trade.data))
  steps.push({
    step: 'trade',
    success: true,
    timestamp: step2Start,
    durationMs: step2Duration,
    data: trade.data,
  });

  // Step 3: Send USDC to reserve address
  console.log('[recovery] Step 3: Sending USDC to reserve...')
  const step3Start = Date.now();
  const send = sendUsdc('10', config.reserveAddress, config.dryRun)
  const step3Duration = Date.now() - step3Start;

  if (!send.success) {
    console.error('[recovery] Send failed:', send.error)
    steps.push({
      step: 'send',
      success: false,
      timestamp: step3Start,
      durationMs: step3Duration,
      error: send.error,
    });
    return {
      success: false,
      steps,
      durationMs: Date.now() - startTime,
    };
  }

  console.log('[recovery] Send result:', JSON.stringify(send.data))
  steps.push({
    step: 'send',
    success: true,
    timestamp: step3Start,
    durationMs: step3Duration,
    data: send.data,
  });

  console.log('[recovery] Recovery sequence complete.')

  return {
    success: true,
    steps,
    durationMs: Date.now() - startTime,
  };
}
