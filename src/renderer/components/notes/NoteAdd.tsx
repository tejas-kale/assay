import { useRef, useState } from 'react'
import type { KeyboardEvent, RefObject } from 'react'

type Props = Readonly<{ onSubmit: (title: string, text: string) => void; onCancel: () => void }>

type FieldProps = Readonly<{
  label: string
  placeholder: string
  value: string
  onChange: (value: string) => void
  onKeyDown: (e: KeyboardEvent) => void
}>

function TitleInput({ label, placeholder, value, onChange, onKeyDown }: FieldProps) {
  return (
    <input
      autoFocus
      aria-label={label}
      placeholder={placeholder}
      value={value}
      spellCheck={false}
      onChange={e => {
        onChange(e.target.value)
      }}
      onKeyDown={onKeyDown}
    />
  )
}

function TextArea({ label, placeholder, value, onChange, onKeyDown, area }: FieldProps & Readonly<{ area: RefObject<HTMLTextAreaElement | null> }>) {
  return (
    <textarea
      ref={area}
      aria-label={label}
      placeholder={placeholder}
      value={value}
      onChange={e => {
        onChange(e.target.value)
      }}
      onKeyDown={onKeyDown}
    />
  )
}

/** Title and text of a new note. Enter in the title moves to the text; ⌘Enter saves; Esc cancels. */
export function NoteAdd({ onSubmit, onCancel }: Props) {
  const [title, setTitle] = useState('')
  const [text, setText] = useState('')
  const body = useRef<HTMLTextAreaElement>(null)
  const submit = () => {
    if (title.trim() !== '') onSubmit(title, text)
  }
  const keys = (e: KeyboardEvent) => {
    if (e.nativeEvent.isComposing) return
    if (e.key === 'Escape') {
      e.preventDefault()
      onCancel()
    } else if (e.key === 'Enter' && e.metaKey) {
      e.preventDefault()
      submit()
    }
  }
  return (
    <div className="note-add" data-focus-target tabIndex={-1}>
      <TitleInput
        label="Note title"
        placeholder="Title (the finding, in a line)"
        value={title}
        onChange={setTitle}
        onKeyDown={e => {
          keys(e)
          if (e.key === 'Enter' && !e.metaKey && !e.nativeEvent.isComposing) {
            e.preventDefault()
            body.current?.focus()
          }
        }}
      />
      <TextArea label="Note text" placeholder="Text. Cite runs as [q 12]; link notes as [[ID]]." value={text} onChange={setText} onKeyDown={keys} area={body} />
      <div className="hint">Enter in title: to text · ⌘Enter save · Esc cancel</div>
    </div>
  )
}
