# Contributing

Thanks for your interest. Small, focused pull requests are the easiest to review and merge.
Issues for bugs, questions and feature ideas are equally welcome.

## Prerequisites

- Node.js `>=22`
- pnpm via corepack — run `corepack enable` once; the pinned version in each `package.json` is used automatically.
  **Do not run `npm install`.** Supply-chain defenses live in `pnpm-workspace.yaml` and are silently ignored by npm.
- `ffmpeg` on your PATH (recorder tests need it)
- `gitleaks` (`brew install gitleaks`), then `sh scripts/setup-hooks.sh` to enable the pre-commit / pre-push hooks

## Repository layout

| Path | What it is |
|---|---|
| `recorder/` | Discord bot (Node.js, `@discordjs/voice`). Records per-speaker tracks, merges to WAV, runs STT, uploads to `web`. Deployed to Fly.io. |
| `recorder/src/stt/` | STT provider abstraction. `index.js` dispatches on `STT_PROVIDER`. |
| `web/` | Cloudflare Worker: Discord OAuth2 login, role-gated web UI, ingest API, D1 schema (`schema.sql`), R2 delivery. |
| `scripts/` | Local maintenance helpers. |

`recorder/` and `web/` are independent pnpm projects with separate lockfiles.

## Running tests

```bash
# recorder
cd recorder
pnpm install --frozen-lockfile
pnpm test            # node:test; Discord and OpenAI are faked, ffmpeg is real

# web
cd web
pnpm install --frozen-lockfile
# ingest smoke test against a local Worker — see the header of web/test/smoke.mjs for setup
node test/smoke.mjs
SMOKE_BIG=1 node test/smoke.mjs   # large-upload path
```

CI runs the recorder tests, the web smoke test and gitleaks on every PR.

## Adding an STT provider

This is the most self-contained contribution. `recorder/src/stt/local.js` (faster-whisper) is currently a stub.

1. Create `recorder/src/stt/<name>.js` exporting

   ```js
   export async function transcribe(audioPath, { language }) {
     return {
       text: '...',                                   // full transcript
       segments: [{ start: 0, end: 1.2, text: '...' }], // seconds
       engine: '<name>/<model>',
     };
   }
   ```

2. Register it in `recorder/src/stt/index.js` by adding one line to `PROVIDERS`.
3. Document any new environment variables in `recorder/.env.example` and the README table.
4. Add a test under `recorder/test/` that exercises your provider with a fake backend.

`pipeline.js` only calls `transcribe()`; it must not need to know which provider is active.

## Code style

- ESM `import` / `export`, two-space indentation, semicolons, single quotes
- Small functions with explicit names (`handleIngest`, `setRequiredRole`, `parsePromptChannelIds`)
- Test files: `*.test.mjs` in `recorder/test/`
- User-facing strings are currently mostly Japanese; keep nearby text consistent rather than mixing languages within one message

## Commits and pull requests

- Commit prefixes: `feat:`, `fix:`, `test:`, `ci:`, `docs:`, `chore:`; one behavior change per commit
- PR description: the user-visible change, the commands you ran to verify it, and related issues
- Screenshots only for web UI changes

## Dependencies and security

- Dependency install scripts are denied unless listed in `allowBuilds` (`pnpm-workspace.yaml`).
  If `pnpm install` fails with `ERR_PNPM_IGNORED_BUILDS`, find out why the package needs a build before adding it; never use `dangerouslyAllowAllBuilds`.
  Removing `@discordjs/opus` from `allowBuilds` breaks recording.
- `minimumReleaseAge: 10080` (minutes = 7 days) blocks freshly published versions. Use `pnpm add <pkg> --allow-any-release-age` only when you have a concrete reason.
- Never commit Discord tokens, OpenAI keys, Cloudflare secrets, or real `fly.toml` / `wrangler.toml` / `.env`. Start from the `*.example` files.
- `INGEST_SECRET` must match between `recorder` and `web`.

## Reporting security issues

Please do not open a public issue for vulnerabilities; contact the maintainer via the profile links at https://github.com/somasekimoto instead.
