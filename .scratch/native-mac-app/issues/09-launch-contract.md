# How the launch contract changes for a Python server and hooks

Type: grilling
Status: open
Blocked by: 04, 08

## Question

The contract currently says the server command is exactly node with one argument, and launchers must provide Node 22 or later. Decide:
- the new server and hook commands (the venv's python)
- what the Podman wrapper must change
- whether the contract carries a version
- how both apps' sessions coexist during the switch
