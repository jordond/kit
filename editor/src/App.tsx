import { useEffect } from 'react'
import { Filmstrip } from './components/Filmstrip'
import { Header } from './components/Header'
import { Stage } from './components/Stage'
import { Loading, LoadError, MigrateNotice, NoProject } from './components/States'
import { useEditor } from './store'

export function App() {
  const load = useEditor((s) => s.load)
  const session = useEditor((s) => s.session)
  const project = useEditor((s) => s.project)
  const loadAll = useEditor((s) => s.loadAll)

  useEffect(() => {
    void loadAll()
  }, [loadAll])

  return (
    <div className="flex h-full flex-col">
      <Header />
      {load.status === 'loading' && <Loading />}
      {load.status === 'error' && <LoadError message={load.message} onRetry={() => void loadAll()} />}
      {load.status === 'ready' && session && !project && <NoProject path={session.projectPath} />}
      {load.status === 'ready' && session && project && (
        <>
          {project.version !== 2 && <MigrateNotice />}
          <div className="flex min-h-0 flex-1">
            <Filmstrip />
            <Stage />
          </div>
        </>
      )}
    </div>
  )
}
