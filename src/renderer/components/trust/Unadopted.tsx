// "Not yet approved in this app": files already in trusted/ and dictionaries/ that the ledger does not cover, as main
// reads them. Each group is looked at and adopted on its own; there is no adopt-all (specs/trust-ledger.md).
import { useEffect, useState } from 'react'

import type { TrustUnadoptedResult, UnadoptedGroup } from '../../../core/trustAdopt.ts'
import { hashesOf } from '../../../core/trustApprove.ts'
import { CodeView } from '../CodeView.tsx'

export function languageOf(file: string): 'sql' | 'python' | undefined {
  if (file.endsWith('.sql')) return 'sql'
  return file.endsWith('.py') ? 'python' : undefined
}

const keyOf = (group: UnadoptedGroup): string => `${group.kind}/${group.name}`

/** The groups main finds uncovered, read again whenever `reloadKey` changes and after each adoption. */
function useUnadopted(reloadKey: string) {
  const [result, setResult] = useState<TrustUnadoptedResult>()
  const [again, setAgain] = useState(0)
  useEffect(() => {
    let isLive = true
    void window.app.trust.unadopted().then(next => {
      if (isLive) setResult(next)
    })
    return () => {
      isLive = false
    }
  }, [reloadKey, again])
  return {
    result,
    reload: () => {
      setAgain(n => n + 1)
    },
  }
}

function GroupFiles({ group }: Readonly<{ group: UnadoptedGroup }>) {
  return (
    <>
      <div className="dim">Adopt approves exactly these files, as read from the folder now:</div>
      {group.problem !== undefined && <div className="trust-state bad">{group.problem}</div>}
      {group.files.map(file => (
        <div key={file.name} className="trust-code">
          <div className="dim" title={file.sha256}>
            {file.name} · sha256 {file.sha256.slice(0, 12)}…
          </div>
          <CodeView code={file.text} language={languageOf(file.name)} focusKey={`adopt/${keyOf(group)}/${file.name}`} original onToggleOriginal={() => undefined} passive unfocusable />
        </div>
      ))}
    </>
  )
}

export function Unadopted(props: Readonly<{ reloadKey: string; onToast: (text: string) => void }>) {
  const { result, reload } = useUnadopted(props.reloadKey)
  const [chosenKey, setChosenKey] = useState<string>()
  const [isSending, setSending] = useState(false)
  if (!result) return null
  if (!result.ok) return <div className="trust-state bad">{result.message}</div>
  if (result.groups.length === 0) return null
  const chosen = result.groups.find(group => keyOf(group) === chosenKey)

  const adopt = (group: UnadoptedGroup) => {
    setSending(true)
    void window.app.trust
      .adopt({ name: group.name, kind: group.kind, hashes: hashesOf(group.files) })
      .then(done => {
        props.onToast(done.message)
        setChosenKey(undefined)
        reload()
      })
      .finally(() => {
        setSending(false)
      })
  }

  return (
    <div className="trust-unadopted">
      <div className="trust-title">Not yet approved in this app</div>
      <div className="dim">These were in trusted/ or dictionaries/ before the app kept a ledger. Until you adopt one, it is not trusted. Look at each before you adopt it.</div>
      <div className="trust-proposals">
        {result.groups.map(group => (
          <div key={keyOf(group)} className={group === chosen ? 'trust-proposal selected' : 'trust-proposal'} onClick={() => { setChosenKey(keyOf(group)) }}>
            <span>{group.name}</span>
            <span className="dim">{group.kind === 'calculation' ? 'trusted' : 'dictionaries'}/ · {group.files.length} {group.files.length === 1 ? 'file' : 'files'}</span>
            <button disabled={isSending || group.problem !== undefined || group !== chosen} title={group === chosen ? undefined : 'Select the group and look at its files first'} onClick={() => { adopt(group) }}>
              Adopt
            </button>
          </div>
        ))}
      </div>
      {chosen && <GroupFiles group={chosen} />}
    </div>
  )
}
