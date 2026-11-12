// What the Steps tab asked and what waits for a reply is the window's, not one mount's: the tab unmounts when the user
// leaves it and must not ask again on the next visit, and the data pane has to know which replies are ours. So it lives
// here, in one store only `update` writes; the decisions are in core/stepsRequests.ts.
import { noRequests } from '../../../core/stepsRequests.ts'
import type { StepsRequests } from '../../../core/stepsRequests.ts'

let store: StepsRequests = noRequests

export const readStore = (): StepsRequests => store

export const update = (change: (state: StepsRequests) => StepsRequests) => {
  store = change(store)
}

/** Whether the request with this id is the tab's: the data pane leaves its reply to it. */
export const isStepsRequest = (id: string) => store.pending.has(id)
