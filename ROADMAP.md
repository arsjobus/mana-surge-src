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

- [x] Record the current game behavior and identify every DOM element referenced by the script.
- [x] Group the existing functions and constants by the target modules above; note cross-module dependencies before moving code.
- [x] Decide which state fields belong in `GameState` (`tiles`, `troops`, players, current player, game-over status, settings, and pending human choice) and which are scene or view state.
- [x] Keep `src/main.js` as the stable entry point while extracting modules behind it.

#### Boundary inventory (current implementation)

The current match starts only after the start-screen button boots Phaser. Each player's turn runs start, move I, combat, move II, and end phases; the loop advances among three seats until a player reaches the configured mana threshold. Humans choose a seat, CPU difficulty, and win score before starting. The rules include adjacent spawning and movement, simultaneous combat, shrine bonuses and locks, thorns, dagger sacrifice, and mana scoring. The UI also supports help, credits, mute, restart, and play again. The migration should preserve this flow and its current visuals and controls.

DOM references in `src/main.js`:

- Boot and setup: `game-container`, `ui-stage`, `hidden-start-overlay`, `.color-btn` (`data-color`), `.diff-btn` (`data-diff`), `winscore-slider`, `winscore-value`, `intro-winscore`, `start-btn`.
- HUD and interaction: `mute-btn`, `tile-info`, `mana-panel`, `turn-text`, `turn-dot`, `ap-pips`, `phase-text`, `skip-btn`, `dagger-btn`, `restart-btn`.
- Help and credits: `rules-btn`, `help-btn`, `help-modal`, `help-winscore`, `close-help`, `close-help-x`, `credits-btn`, `credits-modal`, `credits-list`, `close-credits`, `close-credits-x`.
- Victory and replay: `victory-modal`, `victory-title`, `victory-text`, `playagain-btn`.
- The script also creates mana rows and action-point pips dynamically, and uses `.modal-box` under each modal for scroll reset. `bg-vignette` is present in the HTML but is not referenced by the script.

Function and constant ownership for extraction:

- `data/`: `TILE_INFO`, `LOCKING_TYPES`, `WEIGHT_PRESETS`, `COLOR_META`, and `BOARD_DATA`.
- `utils/hex.js`: `N`, `INNER_RADIUS`, `HEX_SIZE`, `DIRS`, `key`, `neighbors`, `hexDistance`, `axialToPixel`, `hexPolygonPoints`, cube/axial conversion and rotation helpers, and `shuffle`.
- `utils/async.js`: `sleep` and `tweenPromise`.
- `board/BoardModel.js`: tile/player access helpers (`getTile`, `isLocked`, `getStats`, `getTroopAt`, `isEmptyTile`, `countTiles`, `hasLegalMove`, `hasLegalAttack`), `buildBoard`, and initial troop placement.
- `board/BoardRenderer.js`: SVG/texture generation (`svgUrl`, `loadSVGTexture`, `buildTextures`), board draw (`renderBoard`), and board presentation constants (`ICON_FOR_TYPE`, `BADGE_TYPES`, scales).
- `entities/Troop.js`: `createTroop`, `destroyTroop`, `refreshLockVisual`, `burst`, and `moveSpritesTo`.
- `systems/AudioSystem.js`: `loadBGM` and `startBGM`.
- `ui/BoardInput.js`: highlight helpers, tile inspection, pending human choice (`waitFor`), click handlers, invalid-move feedback, and `setupTileInput`.
- `ui/GameHUD.js`: `buildManaPanel`, `updateHUD`, `setPhaseUI`, and `log`; `cssColor` is a shared presentation helper.
- `systems/SpawnSystem.js`: spawn portion of `startPhase`, `chooseSpawnTileHuman`, and `cpuChooseSpawnTile`.
- `systems/CombatSystem.js`: dagger availability/decision, `performSacrifice`, combat resolution (`executeAttack`), and attack scoring/selection.
- `systems/TurnSystem.js`: phase sequencing (`startPhase`, `movePhase`, `combatPhase`, `endPhase`), `executeMove`, `playTurn`, `gameLoop`, and victory determination/display trigger.
- `ai/BehaviorTree.js`: `Selector`, `Sequence`, `Condition`, and `Action`.
- `ai/CpuMoveAI.js`: move behavior tree/constants, progress/isolation helpers, `scoreMoveTarget`, and `cpuChooseMove`.
- `ai/CpuCombatAI.js`: combat behavior tree/constants, `cpuChooseAttack`, and `cpuShouldUseDagger`.
- `ui/ModalUI.js`: start-screen and button wiring, help and credits modal functions/data, victory presentation, and restart handlers.
- `ui/UIStage.js`: `syncUIStage` and resize/observer wiring currently inside `boot`.
- `config/gameConfig.js` and `src/main.js`: Phaser config/creation and the stable browser entry point, respectively; `MainScene` becomes `scenes/MainScene.js`.

Cross-module dependencies to watch: board queries are used by rendering, input, rules, and AI; troop operations need both `GameState` and scene visuals; turn/combat/spawn systems call UI and animation helpers; AI decisions consume board/player state and difficulty weights but should not receive Phaser sprites or DOM nodes. Resolve these through explicit parameters/callbacks and keep view objects out of `GameState`.

`GameState` should own mutable match data: `tiles`, `troops`, `nextTroopId`, `players`, `currentPlayerIndex`, `gameOver`, settings (`difficulty`, `winScore`, `humanColorIndex`), and the pending human choice (`pending`). Keep the Phaser `scene`, `bgmSound`, `phaserGame`, board pixel origin, highlight sprites, and selection sprite in scene/view or system instances. `WEIGHT_PRESETS`, board/tile definitions, and color metadata remain immutable data rather than mutable match state.

### 2. Extract pure data and utilities

- [x] Move hex coordinate math and general async helpers into `utils/` without changing their behavior.
- [x] Move tile descriptions, locking tile types, colors, and other static rules into `data/gameData.js`.
- [x] Move the fixed `BOARD_DATA` layout into `data/boardData.js` and export it as read-only data.
- [x] Move difficulty weight presets into `data/aiWeights.js`; preserve the trainer documentation and weight values.
- [x] Update imports and confirm there are no circular dependencies among these modules.

### 3. Separate board and troop responsibilities

- [x] Extract board construction and tile/state queries into `board/BoardModel.js`.
- [x] Extract SVG texture creation and board drawing into `board/BoardRenderer.js`.
- [x] Extract troop sprite creation, destruction, movement animation, lock visuals, and effects into `entities/Troop.js` (or a small troop view module if that is clearer).
- [x] Keep gameplay rules such as legal movement and tile effects in model/system code rather than in rendering functions.

### 4. Separate rules and turn flow

- [x] Extract attack resolution and sacrifice rules into `systems/CombatSystem.js`.
- [x] Extract spawn selection and troop spawn rules into `systems/SpawnSystem.js`.
- [x] Extract start, move, combat, and end phases plus turn sequencing into `systems/TurnSystem.js`.
- [x] Centralize match data access through `GameState`; avoid duplicating state or exposing mutable collections more widely than needed.
- [x] Keep game-over checks and victory determination in the rules/turn layer, with UI only displaying the outcome.

### 5. Extract CPU behavior

- [x] Move behavior-tree combinators into `ai/BehaviorTree.js`.
- [x] Move move scoring and move selection into `ai/CpuMoveAI.js`.
- [x] Move attack scoring, attack selection, and dagger decisions into `ai/CpuCombatAI.js`.
- [x] Pass state and difficulty weights to AI functions explicitly so AI decisions can be reasoned about independently of Phaser sprites and DOM elements.

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
