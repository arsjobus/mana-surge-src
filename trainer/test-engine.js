'use strict';
const { playMatch } = require('./simulate');
const { DEFAULT_WEIGHTS } = require('./ai');

const N = 200;
const w = [DEFAULT_WEIGHTS, DEFAULT_WEIGHTS, DEFAULT_WEIGHTS];
const wins = [0,0,0];
let timeouts = 0;

for(let i=0;i<N;i++){
  const r = playMatch(w);
  if(r.winner==null) timeouts++; else wins[r.winner]++;
}

console.log(`${N} matches, default weights on all 3 seats`);
console.log('wins by seat:', wins, ' timeouts:', timeouts);
if(timeouts > N*0.1){
  console.error('FAIL: too many matches hit the turn cap without a winner — check for a stuck AI loop.');
  process.exit(1);
}
console.log('OK: engine completes matches reliably.');
