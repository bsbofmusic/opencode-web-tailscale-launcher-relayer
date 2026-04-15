# OpenCode Tailnet Launcher v0.02.1

## Summary

- Fixed the `v0.02` regression that redirected browsers into the raw session API.
- Restored a safe browser flow that lands on the OpenCode web app HTML entrypoint instead of JSON.
- Preserved automatic session restore by injecting `OPENCODE_ROUTE` before the app boots.

## Router Flow

- The landing page now reads `__oc/meta` first.
- It redirects to `/oc-app?...&directory=...&session=...`.
- `bootstrap.js` seeds browser history and sets `process.env.OPENCODE_ROUTE` so the frontend opens the target session on load.

## Notes

- `v0.02` should be considered superseded by `v0.02.1`.
- Windows launcher behavior is unchanged.
