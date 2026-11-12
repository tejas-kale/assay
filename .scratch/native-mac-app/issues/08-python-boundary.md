# Where the Python server ends and the Swift app begins

Type: grilling
Status: open
Blocked by: 04

## Question

Settle the boundary between the Python server and the Swift app:
- how the file protocol is described so both sides agree (JSON Schema, Pydantic models generating schemas, or something else)
- which shared logic lives only in Python
- what the Swift app computes itself
- how the protocol is versioned so Electron Assay and the hybrid can open the same analysis

Inputs from the server inventory: choose between Python serving the app parsed views and shared fixtures for parsing rules written in both languages.
