# Contributing

Thanks for helping improve Family Print Lab. Bug reports, printer-model reports and pull requests are all welcome.

## Before you start

- For anything bigger than a small fix, open an issue first so we can agree on the approach.
- Printer reports are especially useful: if you own a Bambu Lab model other than the one the app was built on, a sanitized MQTT report (no serial number or access code) helps the parser support it.

## Development

The app lives in [`app/`](app/). See [`app/README.md`](app/README.md) for setup and architecture.

```sh
cd app
nvm use && npm install
npm run dev:sim           # app + simulated printer, separate database
```

Before opening a pull request, run:

```sh
npm run check             # types
npm run lint              # prettier + eslint (npm run format fixes most issues)
npm run test:unit -- --run
npm run test:e2e          # needs Playwright's Chromium: npx playwright install chromium
```

Tests never call a real AI provider or printer. Keep it that way: stub providers and use the simulator.

## Guidelines

- Match the surrounding code: TypeScript, Svelte 5 runes, Zod validation, every write through the service layer in `src/lib/server/lab.ts`.
- Schema changes need a Drizzle migration (`npm run db:generate`), and existing databases must keep working.
- Keep the app local-first. New network calls must be opt-in and documented in the README's privacy section.
- Never commit secrets, printer access codes, or personal data in fixtures.

## License of contributions

The project is licensed under [AGPL-3.0-or-later](LICENSE). By submitting a contribution, you agree that it is licensed under the same terms. Please sign off your commits (`git commit -s`) to certify the [Developer Certificate of Origin](https://developercertificate.org/).
