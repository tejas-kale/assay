import { useEffect, useState } from 'react'

import type { DoctorView } from '../../shared/ipc.ts'

/** The Doctor's view, kept current as the backend is prepared and checks finish. */
export function useDoctor(): [DoctorView | undefined, (view: DoctorView) => void] {
  const [view, setView] = useState<DoctorView>()
  useEffect(() => {
    void window.app.doctor.get().then(setView)
    return window.app.doctor.onChange(setView)
  }, [])
  return [view, setView]
}

/** Settings' Doctor: each tool Assay needs, the venv's state, and a Recheck button. */
export function Doctor() {
  const [view, setView] = useDoctor()
  if (!view) return null
  const recheck = () => void window.app.doctor.recheck().then(setView)
  return (
    <section className="doctor" aria-label="Doctor">
      <div className="doctor-head">
        <label>Doctor: Assay {view.version}</label>
        <button type="button" onClick={recheck} disabled={view.isChecking}>
          {view.isChecking ? 'Checking...' : 'Recheck'}
        </button>
      </div>
      {view.preparing && <div className="hint">{view.preparing}</div>}
      {view.error && <div className="status warn">{view.error}</div>}
      <ul>
        {view.checks.map(check => (
          <li key={check.name} className={`doctor-check ${check.status === 'ok' ? '' : 'warn'}`}>
            <span className="doctor-name">{check.name}</span>
            <span className="doctor-status">{check.status}</span>
            <span className="doctor-detail">
              {check.detail}
              {check.fix && <code>{check.fix}</code>}
            </span>
          </li>
        ))}
      </ul>
    </section>
  )
}
