# 05: Rich rows for notes and one-line rows for threads

**What to build:** `note` shows the new note rendered as Markdown; `revise_note` shows its change as a coloured diff;
`park`, `close`, `focus` and `order` show one line each naming the thread; `link_notes` and `note_labels` show one
line each. Spec: `specs/rich-conversation.md`.

**Blocked by:** 03 (SQL rich row).

**Status:** ready-for-agent

- [ ] A `revise_note` diff parses as hunks; one that cannot draws as plain text.
- [ ] Row-model tests cover `note`, `revise_note` and each thread tool; mod tests mount each on the terminal surface.
