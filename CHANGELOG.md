# Changelog

## 1.0.0

- `? <description>` turns plain words into a shell command in the omp composer as `!<command>`; `??` gives `!!`.
- A plain-words line under the composer explains the command and warns when it is destructive.
- The spellbook: commands sent after `?` are saved under your words; Tab on a `?` line recalls them without a model call.
- Morph styles `diff` (colour), `decode`, `rewind` and `none`; motion follows omp's Motion setting and Tern's Reduce Motion.
- Model from the `spellbook` role, else `smol`, else the session model; the request carries a small context packet only.
- Commands are written for the shell omp's `!` runs in on Windows, Linux and macOS.
