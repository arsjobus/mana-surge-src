# Repository Guidelines

## Project Structure & Module Organization

Mana Surge is a browser game built with Phaser 3. The current game is a single script in `src/main.js`; `index.html` loads the local Phaser build from `assets/scripts/phaser.min.js` and game styles from `assets/styles/main.css`. Music and its license are in `assets/music/`. The standalone headless AI trainer lives in `trainer/`, with its rules engine, AI, scripts, and generated presets under `trainer/weights/`. `ROADMAP.md` describes a proposed modular structure; treat it as a plan, not as existing code. There is no separate browser test directory.

## Build, Test, and Development Commands

Serve the repository root over HTTP so the browser can load the game and music:

```sh
python3 -m http.server 8000
```

Then open `http://localhost:8000`. The trainer has no build step or external runtime dependencies. From `trainer/`, run `npm test` to smoke-test 200 simulated matches, `npm run train` to evolve weights, and `npm run calibrate` to generate difficulty presets. Training can take longer and rewrites weight output; use a fixed seed when reproducibility matters.

## Coding Style & Naming Conventions

Follow the existing JavaScript style: two-space indentation, semicolons, single quotes in game code, and descriptive camelCase function and variable names. Use PascalCase for Phaser scene classes and uppercase names for constants. Keep game rule changes aligned with the corresponding trainer implementation when both model the same behavior. Avoid adding dependencies or a build system without a clear need. No formatter or linter is configured.

## Testing Guidelines

Run `cd trainer && npm test` after changing the trainer engine or AI. For browser-game changes, start the local server and manually check startup, the affected interaction, and a full match when turn or victory rules change. Verify the browser console for runtime errors. There is no configured coverage target or automated browser test suite.

## Commit & Pull Request Guidelines

Recent commits use short, direct subjects, often with prefixes such as `feat:`, `chore:`, or `style:`. Continue that pattern (for example, `fix: prevent illegal shrine moves`). Pull requests should summarize behavior changes, list verification performed, link related issues when applicable, and include screenshots for visible UI changes. Call out any changed AI weights or generated trainer outputs.

## AI Weights and Configuration

Keep trainer changes reproducible and review generated JSON before committing it. The trainer README documents its commands and weight workflow; update the game-side presets in `src/main.js` when new weights are intended for the browser game. Do not commit unrelated training output or machine-specific files.
