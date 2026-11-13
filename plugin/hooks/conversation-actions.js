// Pure UI descriptions: the render module keeps every capability call on its own literal `$`.
export function actionButtons({ Button, row, id, submit }) {
  if (row.running || !row.file || row.blockedReason) return []
  return [
    h(Button, { key: `edit:${id}`, label: 'edit', onPress: () => submit('edit', row.file) }),
    h(Button, { key: `rerun:${id}`, label: 're-run', onPress: () => submit('rerun', row.file) }),
  ]
}

export function actionRequest(backend, action, file) {
  if (!backend) return { error: 'ASSAY_BACKEND is missing; no run was sent.' }
  return {
    argv: ['node', `${backend}/out/cli/run-action.mjs`],
    options: { stdin: JSON.stringify({ action, file }), timeoutMs: 600000 },
  }
}

export function actionMessage(result) {
  if (result.exitCode !== 0) return result.stderr.trim() || 'The request helper failed; no run was sent.'
  try {
    const outcome = JSON.parse(result.stdout)
    if (outcome?.ok === true && outcome.unchanged === true) return 'No changes; no run was sent.'
    if (outcome?.ok === true && typeof outcome.id === 'string') return 'Queued a new user run.'
    return typeof outcome?.message === 'string' ? outcome.message : 'The request helper returned no result.'
  } catch {
    return 'The request helper returned an unreadable result.'
  }
}
