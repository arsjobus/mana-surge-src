# Mana Surge Code Organization Roadmap

## Goal

Break the current single-file Phaser 3 game in `src/main.js` into small ES modules grouped by responsibility. Keep gameplay, visuals, controls, and the existing browser launch flow working throughout the migration. This document is a plan; it does not imply that the refactor has started.

## Organization strategy

Use a feature-light, responsibility-based structure that fits a small Phaser game:

```text
src/
  main.js                    # browser entry point and Phaser game creation
  config/
    gameConfig.js            # canvas, scale, parent, and scene registration
  data/
    boardData.js             # fixed board layout
    gameData.js              # tile descriptions, colors, rules constants
    aiWeights.js              # difficulty presets
  scenes/
    MainScene.js             # scene lifecycle and orchestration
  state/
    GameState.js             # match state and state access/update operations
  utils/
    hex.js                   # axial/cube math and coordinate helpers
    async.js                 # sleep and tween promise helper
  board/
    BoardModel.js            # board creation and tile queries
    BoardRenderer.js         # tile textures and board rendering
  entities/
    Troop.js                 # troop creation, movement, removal, visual state
  systems/
    TurnSystem.js            # turn and phase sequencing
    CombatSystem.js          # attacks, sacrifice, and combat resolution
    SpawnSystem.js            # spawn choices and spawn rules
    AudioSystem.js            # background music load/play/mute behavior
  ai/
    BehaviorTree.js           # selector, sequence, condition, action helpers
    CpuMoveAI.js              # move scoring and move selection
    CpuCombatAI.js            # attack scoring, attack selection, dagger choice
  ui/
    BoardInput.js             # tile/troop selection and highlights
    GameHUD.js                # mana panel, phase labels, log, action buttons
    ModalUI.js                # help, credits, victory, and start-screen wiring
    UIStage.js                # DOM HUD alignment with the Phaser canvas
```

Keep the static HTML, CSS, Phaser distribution, and music in their existing locations. Prefer named exports and explicit imports. Pass the Phaser scene, game state, and callbacks into systems that need them instead of introducing more module-level mutable globals. `GameState` should own the mutable match data; visual objects such as Phaser sprites should remain in the presentation layer.

## Step-by-step checklist

### 1. Establish the boundaries

- [ ] Record the current game behavior and identify every DOM element referenced by the script.
- [ ] Group the existing functions and constants by the target modules above; note cross-module dependencies before moving code.
- [ ] Decide which state fields belong in `GameState` (`tiles`, `troops`, players, current player, game-over status, settings, and pending human choice) and which are scene or view state.
- [ ] Keep `src/main.js` as the stable entry point while extracting modules behind it.

### 2. Extract pure data and utilities

- [ ] Move hex coordinate math and general async helpers into `utils/` without changing their behavior.
- [ ] Move tile descriptions, locking tile types, colors, and other static rules into `data/gameData.js`.
- [ ] Move the fixed `BOARD_DATA` layout into `data/boardData.js` and export it as read-only data.
- [ ] Move difficulty weight presets into `data/aiWeights.js`; preserve the trainer documentation and weight values.
- [ ] Update imports and confirm there are no circular dependencies among these modules.

### 3. Separate board and troop responsibilities

- [ ] Extract board construction and tile/state queries into `board/BoardModel.js`.
- [ ] Extract SVG texture creation and board drawing into `board/BoardRenderer.js`.
- [ ] Extract troop sprite creation, destruction, movement animation, lock visuals, and effects into `entities/Troop.js` (or a small troop view module if that is clearer).
- [ ] Keep gameplay rules such as legal movement and tile effects in model/system code rather than in rendering functions.

### 4. Separate rules and turn flow

- [ ] Extract attack resolution and sacrifice rules into `systems/CombatSystem.js`.
- [ ] Extract spawn selection and troop spawn rules into `systems/SpawnSystem.js`.
- [ ] Extract start, move, combat, and end phases plus turn sequencing into `systems/TurnSystem.js`.
- [ ] Centralize match data access through `GameState`; avoid duplicating state or exposing mutable collections more widely than needed.
- [ ] Keep game-over checks and victory determination in the rules/turn layer, with UI only displaying the outcome.

### 5. Extract CPU behavior

- [ ] Move behavior-tree combinators into `ai/BehaviorTree.js`.
- [ ] Move move scoring and move selection into `ai/CpuMoveAI.js`.
- [ ] Move attack scoring, attack selection, and dagger decisions into `ai/CpuCombatAI.js`.
- [ ] Pass state and difficulty weights to AI functions explicitly so AI decisions can be reasoned about independently of Phaser sprites and DOM elements.

### 6. Extract user interface and scene orchestration

- [ ] Move selection, click handling, and board highlights into `ui/BoardInput.js`.
- [ ] Move phase display, mana display, log, and action buttons into `ui/GameHUD.js`.
- [ ] Move help, credits, victory, and start-screen DOM wiring into `ui/ModalUI.js`.
- [ ] Move canvas-to-DOM sizing behavior into `ui/UIStage.js`.
- [ ] Move background music loading and mute controls into `systems/AudioSystem.js`.
- [ ] Reduce `scenes/MainScene.js` to Phaser lifecycle hooks and calls that assemble the state, board, systems, and UI.

### 7. Make boot explicit and finish the migration

- [ ] Add `config/gameConfig.js` for the Phaser configuration and scene registration.
- [ ] Change `src/main.js` into the small application entry point that imports the config and starts Phaser after the start-screen action.
- [ ] Update `index.html` to load `src/main.js` as an ES module (`type="module"`) after confirming the target browsers support the chosen module syntax.
- [ ] Keep Phaser's current local script include available globally unless the project deliberately adopts a package-based Phaser import later.
- [ ] Remove the old IIFE wrapper and any obsolete duplicate code only after all callers use the extracted modules.
- [ ] Update `README.md` with the supported local serving command and note that ES modules require HTTP(S), not direct `file://` opening.

## Completion criteria

- [ ] The game starts from the existing start screen and supports all three seat choices, difficulty choices, and win-score settings.
- [ ] Board layout, turns, movement, combat, spawns, shrines, mana scoring, victory, and restart behavior match the current implementation.
- [ ] Help, credits, HUD, mute, and resize/canvas alignment remain connected and usable.
- [ ] AI weight presets retain their current values and remain compatible with the trainer workflow.
- [ ] No module depends on undeclared globals; imports make module dependencies clear and avoid circular imports.
- [ ] Manual smoke check succeeds through the documented local HTTP server, including one complete match to a victory screen.

## Migration notes

- Extract in small commits, keeping the browser entry point operational after each stage.
- Avoid changing game rules or tuning AI while relocating code; treat behavioral changes as separate work.
- The project currently has no root `package.json` or build pipeline. Native browser ES modules are the least disruptive first step; add a bundler only if later needs such as asset imports, minification, or tests justify it.
- Keep `trainer/` as its own Node project. The game-side AI configuration should continue to document how generated weights are refreshed from that folder.
