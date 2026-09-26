'use strict';
/* ======================================================================
   train.js — evolve BT weight genomes via self-play
   ----------------------------------------------------------------------
   Usage:
     node train.js [--pop 30] [--gens 25] [--matches 8] [--seed 1] [--out weights/evolved.json]

   Approach: standard generational genetic algorithm.
     1. Start from a population of DEFAULT_WEIGHTS plus random mutants.
     2. Each generation, every genome plays a handful of 3-player matches
        against two randomly-chosen population members, rotating which
        seat it sits in (seat position turns out to matter -- see
        engine.js sanity check -- so rotating cancels that bias out).
     3. Fitness = win rate, with a small tie-break bonus from final mana
        (rewards genomes that get *close* to winning even when they lose,
        which is a better learning signal than win/loss alone).
     4. Keep the fittest slice as parents, refill the population with
        uniform-crossover + gaussian-mutated children, elitism-preserve
        the single best genome unchanged each generation.
     5. Print the best fitness per generation so you can watch it climb
        and stop early (Ctrl+C) once it plateaus.

   Output: the single fittest genome, written to --out. Since fitness
   directly rewards winning and mistakes only cost you games, evolution
   naturally drives `mistakeChance` toward 0 on its own -- this genome
   IS your "Hard" difficulty. Run calibrate.js next to derive Easy/Medium
   from it.
--------------------------------------------------------------------- */

const fs = require('fs');
const path = require('path');
const { playMatch } = require('./simulate');
const { DEFAULT_WEIGHTS, GENE_BOUNDS } = require('./ai');

function parseArgs(argv){
  const args = { pop: 30, gens: 25, matches: 8, seed: Date.now() % 1e9, out: 'weights/evolved.json' };
  for(let i=0;i<argv.length;i++){
    const a = argv[i];
    if(a==='--pop') args.pop = parseInt(argv[++i],10);
    else if(a==='--gens') args.gens = parseInt(argv[++i],10);
    else if(a==='--matches') args.matches = parseInt(argv[++i],10);
    else if(a==='--seed') args.seed = parseInt(argv[++i],10);
    else if(a==='--out') args.out = argv[++i];
  }
  return args;
}

// mulberry32 -- small, fast, seedable PRNG so a run can be reproduced.
function mulberry32(seed){
  let a = seed >>> 0;
  return function(){
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const GENES = Object.keys(GENE_BOUNDS);

function clamp(v, lo, hi){ return Math.max(lo, Math.min(hi, v)); }

function randomGenome(rng){
  const g = {};
  GENES.forEach(k=>{
    const [lo,hi] = GENE_BOUNDS[k];
    g[k] = lo + rng()*(hi-lo);
  });
  return g;
}

function mutantOfDefault(rng, strength){
  const g = { ...DEFAULT_WEIGHTS };
  GENES.forEach(k=>{
    const [lo,hi] = GENE_BOUNDS[k];
    const span = hi - lo;
    g[k] = clamp(g[k] + (rng()-0.5)*2*span*strength, lo, hi);
  });
  return g;
}

function crossover(a, b, rng){
  const child = {};
  GENES.forEach(k=>{ child[k] = rng() < 0.5 ? a[k] : b[k]; });
  return child;
}

function mutate(g, rng, rate, strength){
  const child = { ...g };
  GENES.forEach(k=>{
    if(rng() < rate){
      const [lo,hi] = GENE_BOUNDS[k];
      const span = hi - lo;
      child[k] = clamp(child[k] + (rng()-0.5)*2*span*strength, lo, hi);
    }
  });
  return child;
}

function pickOthers(population, excludeIdx, count, rng){
  const idxs = [];
  while(idxs.length < count){
    const i = Math.floor(rng()*population.length);
    if(i!==excludeIdx) idxs.push(i);
  }
  return idxs.map(i=>population[i]);
}

function evaluateFitness(population, matchesPerGenome, rng){
  const fitness = population.map(()=>({ wins:0, games:0, manaSum:0 }));
  population.forEach((genome, gi)=>{
    for(let m=0; m<matchesPerGenome; m++){
      const [oppA, oppB] = pickOthers(population, gi, 2, rng);
      const seat = m % 3; // rotate seat to cancel positional bias
      const weightsByPlayer = [null,null,null];
      weightsByPlayer[seat] = genome;
      weightsByPlayer[(seat+1)%3] = oppA;
      weightsByPlayer[(seat+2)%3] = oppB;
      const result = playMatch(weightsByPlayer, { rng });
      fitness[gi].games++;
      if(result.winner===seat) fitness[gi].wins++;
      fitness[gi].manaSum += result.mana[seat];
    }
  });
  return fitness.map(f=> (f.wins/f.games) + 0.01*(f.manaSum/f.games));
}

function run(){
  const args = parseArgs(process.argv.slice(2));
  const rng = mulberry32(args.seed);
  console.log(`Training: pop=${args.pop} gens=${args.gens} matches/genome/gen=${args.matches} seed=${args.seed}`);

  let population = [];
  population.push({ ...DEFAULT_WEIGHTS });                 // seed with the current hand-tuned AI
  while(population.length < args.pop*0.5) population.push(mutantOfDefault(rng, 0.15));
  while(population.length < args.pop) population.push(randomGenome(rng));

  let best = null, bestFitness = -Infinity;

  for(let gen=1; gen<=args.gens; gen++){
    const fitness = evaluateFitness(population, args.matches, rng);
    const ranked = population.map((g,i)=>({ g, f: fitness[i] })).sort((a,b)=>b.f-a.f);

    if(ranked[0].f > bestFitness){ bestFitness = ranked[0].f; best = ranked[0].g; }
    const avg = fitness.reduce((a,b)=>a+b,0)/fitness.length;
    console.log(`gen ${String(gen).padStart(3)}  best=${ranked[0].f.toFixed(3)}  avg=${avg.toFixed(3)}  (all-time best=${bestFitness.toFixed(3)})`);

    const parentCount = Math.max(4, Math.floor(args.pop*0.3));
    const parents = ranked.slice(0, parentCount).map(r=>r.g);

    const nextGen = [ranked[0].g, best]; // elitism: this gen's best + all-time best survive untouched
    while(nextGen.length < args.pop){
      const pa = parents[Math.floor(rng()*parents.length)];
      const pb = parents[Math.floor(rng()*parents.length)];
      const child = mutate(crossover(pa, pb, rng), rng, 0.2, 0.08);
      nextGen.push(child);
    }
    population = nextGen;
  }

  // Final, more reliable fitness pass over the last generation to pick a winner.
  const finalFitness = evaluateFitness(population, args.matches*3, rng);
  const finalRanked = population.map((g,i)=>({ g, f: finalFitness[i] })).sort((a,b)=>b.f-a.f);
  const champion = finalRanked[0].f > bestFitness ? finalRanked[0].g : best;

  const outPath = path.resolve(__dirname, args.out);
  fs.mkdirSync(path.dirname(outPath), { recursive:true });
  fs.writeFileSync(outPath, JSON.stringify(champion, null, 2));
  console.log(`\nDone. Champion genome written to ${outPath}`);
  console.log('Next: node calibrate.js', args.out);
}

run();
