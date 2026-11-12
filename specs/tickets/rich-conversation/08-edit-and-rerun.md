# 08: `[ edit ]` and `[ re-run ]` send the user's own runs

**What to build:** `[ edit ]` opens a run's code in `$EDITOR`; saving changed code sends it to the server as a new run
by the user that names its source run. `[ re-run ]` sends the code again unchanged. Both go through the server as the
app's requests do, so the one rule holds. Spec: `specs/rich-conversation.md`.

**Blocked by:** 03 (SQL rich row).

**Status:** ready-for-agent

- [ ] Requests are built by the existing request-text function and written as the app writes them: real folders checked, a no-follow exclusive create, a rename into place.
- [ ] Closing the editor without changes, or with a failed exit, sends nothing.
- [ ] The new run is numbered, `author: user`, and names its source in `from`; a case in the backend integration test proves it.
- [ ] Only a person's press reaches these actions: the mod registers no tool or command.
- [ ] Mod tests press both buttons and check the request file written.
