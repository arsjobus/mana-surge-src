'use strict';
/* ======================================================================
   calibrate.js — turn one trained genome into three difficulty presets
   ----------------------------------------------------------------------
   Usage:
     node calibrate.js weights/evolved.json

   Evolution already produces the "Hard" genome (fitness rewards winning,
   so mistakeChance gets driven near 0 on its own). Easy and Medium are
   the SAME genome with a higher mistakeChance -- exactly how index.html's
   difficulty already works today, just with better base weights and a
   value picked by measurement instead of by guessing.

   For each candidate mistakeChance, this plays that genome (with the
   candidate value) against two copies of the pure Hard genome, rotating
   seats to cancel positional bias, and binary-searches for the
   mistakeChance that lands on a target win rate:
     - Easy   -> ~45% of Hard's own baseline win rate
     - Medium -> ~75% of Hard's own baseline win rate
   Hard's baseline (mistakeChance=0) is measured first so the two targets
   scale correctly for this game's specific 3-player dynamics, rather
   than assuming a generic "33% is fair" number.
--------------------------------------------------------------------- */

const fs = require('fs');
const path = require('path');
const { playMatch } = require('./simulate');

function mulberry32(seed){
  let a = seed >>> 0;
  return function(){
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function winRate(candidateWeights, hardWeights, games, rng){
  let wins = 0;
  for(let m=0; m<games; m++){
    const seat = m % 3;
    const weightsByPlayer = [hardWeights, hardWeights, hardWeights];
    weightsByPlayer[seat] = candidateWeights;
    const result = playMatch(weightsByPlayer, { rng });
    if(result.winner===seat) wins++;
  }
  return wins/games;
}

function findMistakeChanceForTarget(hardWeights, targetRate, rng, games){
  let lo=0, hi=0.6;
  for(let iter=0; iter<10; iter++){
    const mid = (lo+hi)/2;
    const candidate = { ...hardWeights, mistakeChance: mid };
    const rate = winRate(candidate, hardWeights, games, rng);
    console.log(`  trying mistakeChance=${mid.toFixed(3)} -> win rate ${(rate*100).toFixed(1)}% (target ${(targetRate*100).toFixed(1)}%)`);
    if(rate > targetRate) lo = mid; else hi = mid; // higher mistakeChance -> lower win rate
  }
  return (lo+hi)/2;
}

function run(){
  const inPath = process.argv[2];
  if(!inPath){
    console.error('Usage: node calibrate.js <path-to-trained-genome.json>');
    process.exit(1);
  }
  const hardRaw = JSON.parse(fs.readFileSync(path.resolve(inPath), 'utf8'));
  const hard = { ...hardRaw, mistakeChance: 0 }; // Hard = the trained genome, zero mistakes
  const rng = mulberry32(7);
  const GAMES = 90;

  console.log('Measuring Hard baseline win rate (vs itself, 3-way)...');
  const baseline = winRate(hard, hard, GAMES, rng);
  console.log(`Hard baseline: ${(baseline*100).toFixed(1)}%\n`);

  console.log('Calibrating Medium (~75% of Hard baseline)...');
  const mediumMistake = findMistakeChanceForTarget(hard, baseline*0.75, rng, GAMES);
  console.log(`Medium mistakeChance = ${mediumMistake.toFixed(3)}\n`);

  console.log('Calibrating Easy (~45% of Hard baseline)...');
  const easyMistake = findMistakeChanceForTarget(hard, baseline*0.45, rng, GAMES);
  console.log(`Easy mistakeChance = ${easyMistake.toFixed(3)}\n`);

  const outDir = path.resolve(__dirname, 'weights');
  fs.mkdirSync(outDir, { recursive:true });
  fs.writeFileSync(path.join(outDir,'hard.json'), JSON.stringify(hard, null, 2));
  fs.writeFileSync(path.join(outDir,'medium.json'), JSON.stringify({ ...hard, mistakeChance: mediumMistake }, null, 2));
  fs.writeFileSync(path.join(outDir,'easy.json'), JSON.stringify({ ...hard, mistakeChance: easyMistake }, null, 2));
  console.log(`Wrote weights/hard.json, weights/medium.json, weights/easy.json`);
}

run();
