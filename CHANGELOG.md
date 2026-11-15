# Changelog

## 0.1.1

- A `?` line now looks like a spell while you type it: the `?` in your theme's accent, the description shimmering
  like one of omp's magic keywords; while the model answers, both pulse. Plain terminals get the `?` in accent and a
  purple hue sweep over the description.
- Spellbook's Tern half, a Tern plugin in `tern/`: a `✦ spellbook` chip where omp's bash chip sits and an accent glow
  around the composer while a spell is in it, the glow breathing while it casts; the shimmer turns around the
  theme's accent. Install it with `tern plugin install github.com/Dazzuh/omp-spellbook/tern`.
- Reduce motion (omp's Motion setting or Tern's Reduce Motion) stops the shimmer and the pulse and leaves the glow
  still.

## 0.1.0

- `? <description>` turns plain words into a shell command in the omp composer as `!<command>`; `??` gives `!!`.
- A plain-words line under the composer explains the command and warns when it is destructive.
- The spellbook: commands sent after `?` are saved under your words; Tab on a `?` line recalls them without a model call.
- Morph styles `diff` (colour), `decode`, `rewind` and `none`; motion follows omp's Motion setting and Tern's Reduce Motion.
- Model from the `spellbook` role, else `smol`, else the session model; the request carries a small context packet only.
- Commands are written for the shell omp's `!` runs in on Windows, Linux and macOS.
