import express from 'express'

const app = express()
app.use(express.json())

let state = {
  totalReserve: 1_000_000,
  totalLiabilities: 800_000,
}

function isSolvent() {
  return state.totalReserve >= state.totalLiabilities
}

// GET /reserves — returns current reserve status
app.get('/reserves', (_req, res) => {
  res.json({
    totalReserve: state.totalReserve,
    totalLiabilities: state.totalLiabilities,
    isSolvent: isSolvent(),
  })
})

// POST /toggle — flip between solvent/undercollateralized
app.post('/toggle', (_req, res) => {
  if (isSolvent()) {
    // Make undercollateralized
    state.totalReserve = 500_000
    state.totalLiabilities = 800_000
  } else {
    // Restore healthy state
    state.totalReserve = 1_000_000
    state.totalLiabilities = 800_000
  }
  res.json({
    totalReserve: state.totalReserve,
    totalLiabilities: state.totalLiabilities,
    isSolvent: isSolvent(),
  })
})

// POST /set-reserves — set exact values
app.post('/set-reserves', (req, res) => {
  const { totalReserve, totalLiabilities } = req.body
  if (typeof totalReserve === 'number') state.totalReserve = totalReserve
  if (typeof totalLiabilities === 'number') state.totalLiabilities = totalLiabilities
  res.json({
    totalReserve: state.totalReserve,
    totalLiabilities: state.totalLiabilities,
    isSolvent: isSolvent(),
  })
})

// GET /state — raw state for debugging
app.get('/state', (_req, res) => {
  res.json({ ...state, isSolvent: isSolvent() })
})

const PORT = process.env.MOCK_API_PORT || 3001

const server = app.listen(PORT, () => {
  console.log(`[mock-api] Reserve API running on http://127.0.0.1:${PORT}`)
})

// Graceful shutdown
process.on('SIGTERM', () => server.close())
process.on('SIGINT', () => server.close())

export { app, server }
