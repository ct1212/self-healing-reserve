export const ReserveAttestation = [
	{
		inputs: [],
		stateMutability: 'nonpayable',
		type: 'constructor',
	},
	{
		anonymous: false,
		inputs: [
			{
				indexed: false,
				internalType: 'bool',
				name: 'isSolvent',
				type: 'bool',
			},
			{
				indexed: false,
				internalType: 'uint256',
				name: 'timestamp',
				type: 'uint256',
			},
		],
		name: 'ReserveStatusUpdated',
		type: 'event',
	},
	{
		inputs: [],
		name: 'isSolvent',
		outputs: [{ internalType: 'bool', name: '', type: 'bool' }],
		stateMutability: 'view',
		type: 'function',
	},
	{
		inputs: [],
		name: 'owner',
		outputs: [{ internalType: 'address', name: '', type: 'address' }],
		stateMutability: 'view',
		type: 'function',
	},
	{
		inputs: [],
		name: 'lastUpdated',
		outputs: [{ internalType: 'uint256', name: '', type: 'uint256' }],
		stateMutability: 'view',
		type: 'function',
	},
	{
		inputs: [
			{
				internalType: 'bool',
				name: '_isSolvent',
				type: 'bool',
			},
		],
		name: 'updateAttestation',
		outputs: [],
		stateMutability: 'nonpayable',
		type: 'function',
	},
	{
		inputs: [
			{ internalType: 'bytes', name: '', type: 'bytes' },
			{ internalType: 'bytes', name: 'report', type: 'bytes' },
		],
		name: 'onReport',
		outputs: [],
		stateMutability: 'nonpayable',
		type: 'function',
	},
] as const
