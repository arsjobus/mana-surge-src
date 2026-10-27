# Repository Guidelines

## Project Structure & Module Organization

Mana Surge is a browser game built with Phaser 3. The game entry point is `src/main.js`; `index.html` loads the local Phaser build from `assets/scripts/phaser.min.js` and game styles from `assets/styles/main.css`. Music and its license are in `assets/music/`. The standalone headless AI trainer lives in `trainer/`, with its rules engine, AI, scripts, and generated presets under `trainer/weights/`. `ROADMAP.md` describes the module structure and remaining completion criteria. Browser E2E tests live in `cypress/e2e/`.

## Build, Test, and Development Commands

Serve the repository root over HTTP so the browser can load the game and music:

```sh
python3 -m http.server 8000
```

Then open `http://localhost:8000`. The trainer has no build step or external runtime dependencies. From `trainer/`, run `npm test` to smoke-test 200 simulated matches, `npm run train` to evolve weights, and `npm run calibrate` to generate difficulty presets. Training can take longer and rewrites weight output; use a fixed seed when reproducibility matters.

Run the browser E2E suite with `npm run cypress:run`. It expects the repository server to be available at `http://127.0.0.1:8000` (start it with `npm run serve` in another terminal first). Cypress has exited with code 134 before reporting results when run in the sandbox; run it outside the sandbox for a successful result and ask me to approve to do so.

## Coding Style & Naming Conventions

Follow the existing JavaScript style: two-space indentation, semicolons, single quotes in game code, and descriptive camelCase function and variable names. Use PascalCase for Phaser scene classes and uppercase names for constants. Keep game rule changes aligned with the corresponding trainer implementation when both model the same behavior. Avoid adding dependencies or a build system without a clear need. No formatter or linter is configured.

## Testing Guidelines

After every change, run the Cypress E2E suite with `npm run cypress:run` to verify the game works as expected. Start the local server with `npm run serve` in a separate terminal before running it. Extend the Cypress suite when a change adds or alters behavior that is not covered yet. Also run `cd trainer && npm test` after changing the trainer engine or AI. For browser-game changes, manually check the affected interaction and verify the browser console for runtime errors; manually play a full match when turn or victory rules change.

## Commit & Pull Request Guidelines

Recent commits use short, direct subjects, often with prefixes such as `feat:`, `chore:`, or `style:`. Continue that pattern (for example, `fix: prevent illegal shrine moves`). Pull requests should summarize behavior changes, list verification performed, link related issues when applicable, and include screenshots for visible UI changes. Call out any changed AI weights or generated trainer outputs.

## AI Weights and Configuration

Keep trainer changes reproducible and review generated JSON before committing it. The trainer README documents its commands and weight workflow; update the game-side presets in `src/main.js` when new weights are intended for the browser game. Do not commit unrelated training output or machine-specific files.
