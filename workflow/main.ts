import {
	type ConfidentialHTTPSendRequester,
	consensusIdenticalAggregation,
	handler,
	ConfidentialHTTPClient,
	CronCapability,
	json,
	ok,
	Runner,
	type Runtime,
	safeJsonStringify,
} from '@chainlink/cre-sdk'
import { z } from 'zod'

const configSchema = z.object({
	schedule: z.string(),
	owner: z.string(),
	url: z.string(),
	threshold: z.number().default(1.0),
})

type Config = z.infer<typeof configSchema>

type ReserveResponse = {
	totalReserve: number
	totalLiabilities: number
	isSolvent: boolean
}

const fetchReserves = (sendRequester: ConfidentialHTTPSendRequester, config: Config) => {
	const response = sendRequester
		.sendRequest({
			request: {
				url: config.url,
				method: 'GET',
				multiHeaders: {
					'secret-header': {
						values: ['{{.SECRET_HEADER}}'],
					},
				},
			},
			vaultDonSecrets: [
				{
					key: 'SECRET_HEADER',
					owner: config.owner,
				},
			],
		})
		.result()

	if (!ok(response)) {
		throw new Error(`HTTP request failed with status: ${response.statusCode}`)
	}

	return json(response) as ReserveResponse
}

const onCronTrigger = (runtime: Runtime<Config>) => {
	runtime.log('Reserve attestation workflow triggered.')

	const confHTTPClient = new ConfidentialHTTPClient()
	const reserves = confHTTPClient
		.sendRequest(
			runtime,
			fetchReserves,
			consensusIdenticalAggregation(),
		)(runtime.config)
		.result()

	// TEE-private comparison: reserves vs liabilities
	const ratio = reserves.totalReserve / reserves.totalLiabilities
	const isSolvent = ratio >= runtime.config.threshold

	runtime.log(
		`Reserve check complete: ratio=${ratio.toFixed(4)}, solvent=${isSolvent}`
	)

	// Only the boolean attestation leaves the TEE
	return {
		result: { isSolvent },
	}
}

const initWorkflow = (config: Config) => {
	const cron = new CronCapability()

	return [handler(cron.trigger({ schedule: config.schedule }), onCronTrigger)]
}

export async function main() {
	const runner = await Runner.newRunner<Config>({ configSchema })

	await runner.run(initWorkflow)
}
