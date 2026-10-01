# Mana Surge — AI Trainer

A headless companion program that evolves the game's CPU behavior-tree
weights via self-play, then calibrates Easy / Medium / Hard from the
result. No browser, no rendering — just the rules and the AI, running
thousands of times a second so it can learn.

## Why this shape, not a "neural net plays the game" approach

Mana Surge's CPU already thinks with a **behavior tree** — a fixed
decision structure (`CPU_MOVE_TREE` / `CPU_COMBAT_TREE` in `index.html`)
whose leaves score candidate moves using a set of hand-tuned numbers
(*"a Mana Pool tile is worth +130", "a free kill is worth +100"*, etc).

Rather than replacing that tree with a neural net (a bigger rewrite, and
harder to debug/tune by hand afterwards), this project treats those
hand-tuned numbers as a **genome** and evolves them:

```
headless rules engine  →  self-play trainer (genetic algorithm)  →  trained weights  →  same behavior tree, smarter numbers
```

The tree structure, priorities, and rules are identical to what ships in
`index.html`. Only the numbers change. That keeps the AI debuggable
("why did it do that? — check the weight") and keeps difficulty tuning
in one place instead of three copy-pasted heuristics.

## Files

| File | Purpose |
|---|---|
| `engine.js` | Headless port of the board/rules (movement, combat, spawning, mana, sacrifice). Mirrors `index.html` exactly — same board layout, same stat math, same win condition. |
| `ai.js` | The behavior tree, with every hardcoded number pulled out into a `weights` object (the "genome"). Also defines `GENE_BOUNDS`, the sane min/max range for each weight during evolution. |
| `simulate.js` | Plays one full 3-player match given three weight genomes (one per seat). |
| `train.js` | The genetic algorithm: evolves a population of genomes via self-play tournaments. |
| `calibrate.js` | Takes the fittest evolved genome ("Hard") and finds the `mistakeChance` values that produce "Medium" and "Easy" at target win rates against it. |
| `test-engine.js` | Smoke test — plays 200 matches, checks nothing hangs or crashes. |
| `weights/` | Output folder. `evolved.json` is train.js's raw output; `easy.json` / `medium.json` / `hard.json` are calibrate.js's three presets. |

## Running it

```bash
cd mana-surge-trainer
node test-engine.js                 # sanity check the engine (should finish in ~1s)

node train.js --pop 40 --gens 40 --matches 8 --seed 12345 --out weights/evolved.json
node calibrate.js weights/evolved.json
```

This produces `weights/easy.json`, `weights/medium.json`, `weights/hard.json`.

### Tuning the run

- `--pop` (population size) and `--gens` (generations): bigger and longer
  finds better weights but takes longer. 40×40 takes under two minutes on
  a laptop; try 80×80 for a more thoroughly-trained result overnight.
- `--matches` (matches per genome per generation): the biggest lever on
  *reliability*. Each match's win/loss has real randomness in it (mistake
  chance, spawn-tile RNG, whichever genome is compared against), so with
  only a few matches a genome can look good or bad by luck. 8 is enough
  to see the population improve; 20+ gives a much more trustworthy signal
  at the cost of proportionally longer runs.
- `--seed`: fixed seed = reproducible run. Change it to explore a
  different evolutionary path.

`calibrate.js` has an equivalent trade-off: it plays `GAMES = 90` matches
per candidate `mistakeChance` value it tries. Raise that constant at the
top of the file for tighter Easy/Medium targets if the win rates it
prints look noisy.

## Integrating the result into the game

`index.html` already has this wired up (look for `WEIGHT_PRESETS` near
the top of the `<script>` block) — the object below is exactly what
`easy.json` / `medium.json` / `hard.json` contain, pasted in as one JS
object per difficulty. Every place the old code referenced
`DIFFICULTY[difficulty].mistakeChance`, it now calls `AIW()` (short for
"AI weights") to get the whole weight set for the active difficulty and
reads the field it needs off that (`AIW().mistakeChance`,
`AIW().manaPool`, `AIW().daggerSurplusThreshold`, etc).

To ship a newly-trained set of weights:

1. Run `train.js` then `calibrate.js` as above.
2. Open each of `weights/easy.json`, `weights/medium.json`, `weights/hard.json`.
3. In `index.html`, find the `WEIGHT_PRESETS` object and replace the
   `easy: {...}`, `medium: {...}`, `hard: {...}` bodies with the new
   JSON (it's already valid JS object syntax, so you can paste it in
   directly — just add the trailing comma between entries).
4. Reload the game. No other code changes needed — `scoreMoveTarget`,
   `cpuChooseAttack`, and `cpuShouldUseDagger` all read from `AIW()`
   already, so every difficulty tier immediately plays with the new
   numbers.

## Why "Hard" wasn't actually hard the first time

The first version of this trainer used a small population (40), few
matches per genome (8), and no memory across generations. Two problems
fell out of that:

1. **Too much noise.** With only 8 matches, a genome's measured win rate
   swings wildly from luck alone, so the "best" genome each generation
   was often just the luckiest one, not the strongest one.
2. **Self-play can cycle instead of improve.** If genome A beats B, B
   beats C, and C beats A, a population can drift in circles forever
   without ever getting objectively better — and a population can even
   *forget* how to beat a strategy an earlier generation had already
   solved, since nothing forces it to stay good against anything but
   its current peers.

Both are fixed now: `--matches` is higher by default, and every few
generations the champion is inducted into a **Hall of Fame** — an
archive of past strong genomes that stays in the opponent pool
permanently (see `pickOpponents` / `hallOfFame` in `train.js`). New
genomes have to keep beating old champions, not just whoever's
currently in the population. Re-run with `node train.js --pop 44 --gens
25 --matches 12` (the settings this repo's `weights/hard.json` were
produced with) and Hard now beats the original hand-tuned weights ~59%
of the time in a 3-way match, well above the ~33% fair share.

## Strategic-depth genes

The original weights were purely "how good is this tile / this attack,
right now" — no sense of time, no defense, no reaction to who's winning.
Four new genes give the behavior tree the vocabulary for that:

| Gene | What it does |
|---|---|
| `economyDecay` | Fades the value of extra-action/extra-spawn shrines as the leading player's mana climbs toward the win threshold. Rushing a spawn shrine on turn 3 pays off over many turns; grabbing one turn 45 when someone's about to win doesn't. `0` = no fade, `~1` = shrines become worthless once someone's near victory. |
| `defendLockedBonus` | Extra score for attacking an enemy troop that's standing next to one of *my* troops already parked on a locked shrine/mana tile — i.e. defending an engine I built, not just chasing new value. |
| `reinforceBonus` | Extra score for moving a troop next to my own locked troop that has no other ally guarding it yet — garrison a shrine instead of leaving it as a free kill. |
| `pressureMarginScale` | Scales how much harder both CPUs lean on whichever player (human or CPU) is currently in the lead, in proportion to how close they are to actually winning. Replaces the old "always target the human" rule — a human who's behind gets left alone; a human about to win gets ganged up on hard. |

These are genes like any other — `train.js` evolves them exactly the
same way, and the trained `hard.json` in this repo has `defendLockedBonus`
and `reinforceBonus` both evolving *above* their seeded starting values,
meaning self-play found defending/garrisoning shrines even more valuable
than the initial guess.


If you add a new tunable heuristic to the CPU AI later, the pattern is:

1. Add it to `DEFAULT_WEIGHTS` and `GENE_BOUNDS` in `ai.js` (pick a
   sensible min/max — too wide and evolution wastes time exploring
   nonsense values, too narrow and it can't find a better answer).
2. Use it in `scoreMoveTarget` / `chooseAttack` / `shouldUseDagger` here
   in `ai.js`.
3. Make the identical change to the corresponding function in
   `index.html`, reading from `AIW()` the same way the existing weights
   do.
4. Re-run `train.js` — the new gene is automatically part of what gets
   evolved.

## Going further (optional, bigger project)

This genetic-algorithm approach tunes the *existing* heuristics — it
can't discover a fundamentally different strategy the hand-written
scoring functions don't have a concept of (e.g. "sometimes it's correct
to feint toward one shrine to bait an opponent away from another").
For that, the next step up is training an actual neural network value
function via self-play reinforcement learning (e.g. a small PPO agent
with action masking, or an AlphaZero-style policy/value net with a
lightweight search), and using its evaluation to score moves inside the
same behavior-tree leaves instead of the hand-written formula. `engine.js`
and `simulate.js` here are already the "headless environment" that kind
of training would run against — the main extra work is the RL training
loop itself and exporting the trained net's forward pass to something
`index.html` can run in-browser (a tiny hand-ported MLP, or
TensorFlow.js).
