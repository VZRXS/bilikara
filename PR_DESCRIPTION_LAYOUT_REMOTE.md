## Summary

This PR adds a normal/hardcore layout switch to both the host page and the remote page, and aligns remote search/gatcha copy with the current host UI.

## Changes

- Add a top-right `普通模式 / 硬核模式` layout toggle on the host page
- Persist host layout mode in `localStorage`
- In host `普通模式`, hide:
  - `bottom-grid`
  - search card
  - cookie card
  - AV sync panel
  - volume panel
- Add a compact `手机点歌` QR module to the host top-right area
- Show a hover popover with the full remote QR, link, and hint text
- Keep host top-right control positions stable between normal/hardcore modes
- Adjust host control widths so the playback mode card does not stretch unexpectedly
- Tweak compact host QR presentation:
  - square corners
  - slightly raised position
  - solid hover popover background
- Add the same `普通模式 / 硬核模式` layout toggle to the remote page
- Persist remote layout mode in `localStorage`
- In remote `普通模式`, hide:
  - search panel
  - gatcha panel
  - AV sync panel
  - volume panel
- Align remote search and gatcha copy with the current host page wording

## Files

- `static/index.html`
- `static/styles.css`
- `static/app.js`
- `static/remote.html`
- `static/remote.css`
- `static/remote.js`

## Notes

- `硬核模式` preserves the previous full interface
- `普通模式` reduces visual complexity while keeping core queue/request actions available
- Host remote QR rendering is reused across the bottom remote panel, compact card, and hover popover
- Remote page intentionally does not include QR-specific UI changes

## Testing

- Not run locally in browser
- Recommend verifying:
  - host layout toggle behavior in both modes
  - host compact QR hover popover visibility/readability
  - host top-right control alignment in both modes
  - remote layout toggle behavior in both modes
  - remote hidden panels in normal mode
  - remote search/gatcha copy consistency with host
  - mobile / narrow-width wrapping behavior on both pages
