# 05: Rich rows for notes and one-line rows for threads

**What to build:** `note` shows the new note rendered as Markdown; `revise_note` shows its change as a coloured diff;
`park`, `close`, `focus` and `order` show one line each naming the thread; `link_notes` and `note_labels` show one
line each. Spec: `specs/rich-conversation.md`.

**Blocked by:** 03 (SQL rich row).

**Status:** implemented — live Ghostty acceptance deferred by the user

- [x] A `revise_note` diff parses as hunks; one that cannot draws as plain text.
- [x] Row-model tests cover `note`, `revise_note` and each thread tool; mod tests mount each on the terminal surface.

`conversationNotes.ts` uses successful note calls' submitted Markdown; the server returns an acknowledgement,
not the saved note body. Replacements show a unified diff of the supplied old/new excerpt, labelled as an excerpt
rather than claiming a location in the full note. Retitles and deletions show the acknowledgement as plain text.
Server warnings remain visible. The mod reads no root-note files. Native mod tests mount note, revision and all
six thread/housekeeping tool rows; long diffs fall back to plain text above the Code element's size limit.
