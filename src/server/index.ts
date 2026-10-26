import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import fastifyStatic from '@fastify/static'
import { buildAgentSettings, validateAgentSettings } from '../agents/settings.js'
import { loadConfig } from '../config.js'
import { stopAll } from '../core/appRunner.js'
import { EventBus } from '../core/events.js'
import { Scheduler } from '../core/scheduler.js'
import { buildServer } from './routes.js'

const SHUTDOWN_WAIT_MS = 5_000

async function main(): Promise<void> {
  const root = resolve(import.meta.dirname, '../..')
  const cfg = loadConfig(root)
  const settingsProblems = validateAgentSettings(buildAgentSettings(root))
  if (settingsProblems.length > 0) {
    // `claude -p` silently ignores invalid --settings, so agents would run without the deny list.
    console.warn(`WARNING: agent settings do not have the expected shape:\n  ${settingsProblems.join('\n  ')}`)
  }
  const bus = new EventBus()
  bus.setMaxListeners(0) // each SSE client adds a 'state' and a 'log' listener
  const scheduler = new Scheduler(cfg, bus)
  const app = buildServer(cfg, { scheduler, bus })

  const webDist = resolve(root, 'web/dist')
  if (existsSync(webDist)) {
    await app.register(fastifyStatic, { root: webDist })
    app.setNotFoundHandler((req, reply) => {
      if (req.method === 'GET' && !req.url.startsWith('/api/')) return reply.sendFile('index.html')
      return reply.code(404).send({ error: 'not found' })
    })
  } else {
    console.warn('web/dist not found: only the API is served. Run `npm start` (builds the panel) or `npx vite build web`.')
  }

  await app.listen({ host: '127.0.0.1', port: cfg.port }) // a failed listen must not start the scheduler
  await scheduler.start()
  console.log(`Orchestrator: http://127.0.0.1:${cfg.port} (workspace ${cfg.workspace})`)

  let shuttingDown = false
  const shutdown = (signal: string) => {
    if (shuttingDown) return
    shuttingDown = true
    console.log(`${signal}: shutting down`)
    scheduler.stop()
    const wait = new Promise<void>((res) => setTimeout(res, SHUTDOWN_WAIT_MS).unref())
    void Promise.race([Promise.all([scheduler.idle(), app.close(), stopAll()]), wait]).finally(() => process.exit(0))
  }
  process.on('SIGINT', () => shutdown('SIGINT'))
  process.on('SIGTERM', () => shutdown('SIGTERM'))
  process.on('SIGBREAK', () => shutdown('SIGBREAK')) // Ctrl+Break, or the console window being closed
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
