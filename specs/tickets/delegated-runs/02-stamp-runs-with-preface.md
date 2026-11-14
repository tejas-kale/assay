# 02: Stamp each run with the current preface identity

**What to build:** every run in the analysis records which frozen preface was current when the run was claimed, so each
result stays attached to the prediction it was made under even after the preface is reset for a later task. Spec:
https://github.com/tejas-kale/assay/issues/9#issuecomment-6879918940.

**Blocked by:** 01 (Freeze and reset the preface from the Overview tab).

**Status:** ready-for-agent

- [ ] When a frozen preface is current, every newly claimed SQL, Python, and trusted run records that preface's identity in its run metadata/header and parsed run state.
- [ ] When no preface is frozen (before the first freeze, or after a reset before a new freeze), runs omit the preface identity cleanly.
- [ ] After a reset and a second frozen preface, earlier runs still report the first preface's identity and new runs report the second preface's identity.
