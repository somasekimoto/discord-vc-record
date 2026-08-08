# Repository Guidelines

## Project Structure & Module Organization

This repository has two deployable Node.js ESM packages:

- `recorder/`: Discord voice recorder bot for Fly.io. Runtime code is in `recorder/src/`, STT adapters are in `recorder/src/stt/`, and unit/integration tests are in `recorder/test/*.test.mjs`.
- `web/`: Cloudflare Worker WebUI, auth, ingest API, D1 access, and R2 delivery. Source lives in `web/src/`, the D1 schema is `web/schema.sql`, and the smoke test is `web/test/smoke.mjs`.
- `scripts/`: local maintenance helpers, including `scripts/setup-hooks.sh` for gitleaks hooks.

Keep generated recordings, real `.env` files, `fly.toml`, and `wrangler.toml` out of git. Start from the provided `*.example` files.

## Build, Test, and Development Commands

- `cd recorder && pnpm install`: install recorder dependencies. Requires Node.js `>=22`.
- `cd recorder && pnpm run register`: register Discord slash commands.
- `cd recorder && pnpm run start`: run the bot locally with `.env` configuration.
- `cd recorder && pnpm test`: run Node's built-in test runner over `test/*.test.mjs`.
- `cd web && pnpm install`: install Wrangler for Worker development.
- `cd web && pnpm run dev`: start `wrangler dev`.
- `cd web && pnpm run deploy`: deploy the Worker.
- `cd web && node test/smoke.mjs`: run the ingest smoke test against a local Worker after applying `schema.sql` and starting Wrangler as documented in the test header.

## Coding Style & Naming Conventions

Use ESM `import`/`export`, two-space indentation, semicolons, and single quotes. Prefer small functions with explicit names such as `handleIngest`, `setRequiredRole`, or `parsePromptChannelIds`. Test files should use the `.test.mjs` suffix when run by `pnpm test`. Existing user-facing text is mostly Japanese; keep nearby language consistent.

## Testing Guidelines

Recorder tests use `node:test` and `node:assert/strict`. Add focused tests beside related behavior in `recorder/test/`. Web coverage currently relies on `web/test/smoke.mjs`; update it when ingest, auth, D1, or R2 flows change. For large upload behavior, use `SMOKE_BIG=1 node test/smoke.mjs`.

## Commit & Pull Request Guidelines

Git history uses conventional prefixes such as `feat:`, `fix:`, `test:`, and `ci:` with concise Japanese or English summaries. Keep commits scoped to one behavior change. Pull requests should describe the user-visible change, list verification commands, link related issues, and include screenshots only for WebUI changes.

## Security & Configuration Tips

This repository uses **pnpm** (pinned via `packageManager`); do not run `npm install`. Supply-chain defenses live in each project's `pnpm-workspace.yaml`: dependency build scripts are denied unless listed in `allowBuilds`, and `minimumReleaseAge: 10080` blocks versions published less than 7 days ago (the unit is minutes). If an install fails with `ERR_PNPM_IGNORED_BUILDS`, inspect why the package needs a build before adding it to `allowBuilds`; never use `dangerouslyAllowAllBuilds`. Removing `@discordjs/opus` from `allowBuilds` breaks recording.

Run `sh scripts/setup-hooks.sh` before contributing. Never commit Discord tokens, OpenAI keys, Cloudflare secrets, or real app config. Keep `INGEST_SECRET` synchronized between `recorder` and `web`.
