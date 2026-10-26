import { useEffect, useState } from 'react'
import { api, type ProjectSummary } from './api.js'
import { Icon } from './icons.js'
import { NewProject } from './components/NewProject.js'
import { ProjectList } from './components/ProjectList.js'
import { ProjectPage } from './components/ProjectPage.js'

const POLL_MS = 5000

export type Route = { page: 'list' } | { page: 'new' } | { page: 'project'; id: string }

export function parseRoute(hash: string): Route {
  if (hash === '#/new') return { page: 'new' }
  const m = /^#\/p\/([^/]+)$/.exec(hash)
  if (m) return { page: 'project', id: decodeURIComponent(m[1]!) }
  return { page: 'list' }
}

export function pageTitle(waiting: number): string {
  return waiting > 0 ? `(${waiting}) Orchestrator` : 'Orchestrator'
}

function useHash(): string {
  const [hash, setHash] = useState(() => window.location.hash)
  useEffect(() => {
    const onChange = () => setHash(window.location.hash)
    window.addEventListener('hashchange', onChange)
    return () => window.removeEventListener('hashchange', onChange)
  }, [])
  return hash
}

/** The project list, refreshed every 5 s on every page so the title and the top bar always show who waits. */
function useProjects(hash: string): { projects: ProjectSummary[] | null; error: string | null } {
  const [projects, setProjects] = useState<ProjectSummary[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    let live = true
    const load = () =>
      api.listProjects().then(
        (p) => {
          if (!live) return
          setProjects(p)
          setError(null)
        },
        (e: unknown) => live && setError((e as Error).message),
      )
    void load()
    const timer = setInterval(load, POLL_MS)
    return () => {
      live = false
      clearInterval(timer)
    }
  }, [hash])
  return { projects, error }
}

export function App() {
  const hash = useHash()
  const route = parseRoute(hash)
  const { projects, error } = useProjects(hash)
  const waiting = projects?.filter((p) => p.displayStatus === 'waiting') ?? []

  useEffect(() => {
    document.title = pageTitle(waiting.length)
  }, [waiting.length])

  return (
    <>
      <header className="topbar">
        <a className="brand" href="#/">
          Orchestrator
        </a>
        {waiting.length > 0 && (
          <a
            className="topbar-waiting"
            href={waiting.length === 1 ? `#/p/${encodeURIComponent(waiting[0]!.id)}` : '#/'}
            title={waiting.map((p) => p.name).join(', ')}
          >
            <span className="pulse" aria-hidden="true" />
            <span className="topbar-waiting-text">
              {waiting.length === 1 ? `Ждёт вас: ${waiting[0]!.name}` : `Ждут вас: ${waiting.length}`}
            </span>
          </a>
        )}
        <a className="topbar-new" href="#/new">
          <Icon name="plus" /> <span>Новый проект</span>
        </a>
      </header>
      <main className="main">
        {route.page === 'new' && <NewProject onCreated={(id) => (window.location.hash = `#/p/${encodeURIComponent(id)}`)} />}
        {route.page === 'project' && <ProjectPage key={route.id} id={route.id} />}
        {route.page === 'list' && <ProjectList projects={projects} error={error} />}
      </main>
    </>
  )
}
