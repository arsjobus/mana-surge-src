# Mana Surge

## Setup and Quick Start

Serve the repository root over HTTP so the browser can load ES modules, Phaser, and music:

```sh
python3 -m http.server 8000
```

Then open <http://localhost:8000>. ES modules require HTTP(S); opening `index.html` directly with `file://` will not work.

## Browser checks

Install the development dependency once with `npm install`. In one terminal, run `npm run serve`; in another, run `npm run cypress:run` for headless checks or `npm run cypress:open` to use the Cypress runner. The checks exercise start-screen settings, Phaser startup and HUD, help and credits, canvas/UI resizing, victory presentation, and restart behavior.
