# Mana Surge

## Setup and Quick Start

Serve the repository root over HTTP so the browser can load ES modules, Phaser, and music:

```sh
python3 -m http.server 8000
```

Then open <http://localhost:8000>. ES modules require HTTP(S); opening `index.html` directly with `file://` will not work.

## Build for Itch.io

Run `npm run build:itch` to create `dist/mana-surge-itch.zip`. Upload that ZIP to an Itch.io project configured as an HTML game, with “This file will be played in the browser” enabled. The archive contains `index.html`, `assets/`, and `src/` at its root so the game can load its local Phaser build, styles, music, and ES modules.

The build script uses Python's standard library and does not require installing extra packages.

## Browser checks

Install the development dependency once with `npm install`. In one terminal, run `npm run serve`; in another, run `npm run cypress:run` for headless checks or `npm run cypress:open` to use the Cypress runner. The checks exercise start-screen settings, Phaser startup and HUD, help and credits, canvas/UI resizing, victory presentation, and restart behavior.
