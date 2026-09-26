'use strict';
/* ======================================================================
   engine.js — headless clone of Mana Surge's rules
   ----------------------------------------------------------------------
   Ported directly from index.html's game-state functions (buildBoard,
   setupInitialTroops, createTroop, destroyTroop, executeMove,
   executeAttack, startPhase, endPhase, performSacrifice, getStats,
   isLocked, daggerAvailable, hasLegalMove/Attack). No Phaser, no DOM,
   no sprites, no animation delays -- this exists purely so a training
   program can play thousands of games per second.

   IMPORTANT: if you ever change the rules in index.html (board layout,
   stat modifiers, win condition, spawn/sacrifice logic), mirror the
   change here too, or the AI you train will be learning a slightly
   different game than the one people actually play.
   ====================================================================== */

const DIRS = [[1,0],[1,-1],[0,-1],[-1,0],[-1,1],[0,1]];
function key(q,r){ return q+','+r; }
function neighbors(q,r){ return DIRS.map(d=>({q:q+d[0], r:r+d[1]})); }
function hexDistance(a,b){
  return (Math.abs(a.q-b.q)+Math.abs(a.q+a.r-b.q-b.r)+Math.abs(a.r-b.r))/2;
}

const LOCKING_TYPES = ['extra_action','extra_spawn','mana_pool'];
const UNMISSABLE_CLAIM_TYPES = ['mana_pool','extra_action','extra_spawn','dagger'];

// Exact board layout, copied verbatim from index.html's BOARD_DATA so the
// simulated board is identical to the real one.
const BOARD_DATA = [
{q:-5,r:0,type:'spawner',owner:0},{q:-5,r:1,type:'plain'},{q:-5,r:2,type:'plain'},
{q:-5,r:3,type:'plain'},{q:-5,r:4,type:'atk_minus'},{q:-5,r:5,type:'extra_action'},
{q:-4,r:-1,type:'plain'},{q:-4,r:0,type:'plain'},{q:-4,r:1,type:'atk_plus'},
{q:-4,r:2,type:'thorns'},{q:-4,r:3,type:'atk_plus'},{q:-4,r:4,type:'def_plus'},
{q:-4,r:5,type:'atk_minus'},{q:-3,r:-2,type:'plain'},{q:-3,r:-1,type:'atk_plus'},
{q:-3,r:0,type:'atk_plus'},{q:-3,r:1,type:'def_plus'},{q:-3,r:2,type:'atk_minus'},
{q:-3,r:3,type:'def_plus'},{q:-3,r:4,type:'atk_plus'},{q:-3,r:5,type:'plain'},
{q:-2,r:-3,type:'plain'},{q:-2,r:-2,type:'thorns'},{q:-2,r:-1,type:'def_plus'},
{q:-2,r:0,type:'dagger'},{q:-2,r:1,type:'atk_minus'},{q:-2,r:2,type:'extra_spawn'},
{q:-2,r:3,type:'atk_minus'},{q:-2,r:4,type:'thorns'},{q:-2,r:5,type:'plain'},
{q:-1,r:-4,type:'atk_minus'},{q:-1,r:-3,type:'atk_plus'},{q:-1,r:-2,type:'atk_minus'},
{q:-1,r:-1,type:'atk_minus'},{q:-1,r:0,type:'atk_plus'},{q:-1,r:1,type:'def_plus'},
{q:-1,r:2,type:'atk_minus'},{q:-1,r:3,type:'def_plus'},{q:-1,r:4,type:'atk_plus'},
{q:-1,r:5,type:'plain'},{q:0,r:-5,type:'extra_action'},{q:0,r:-4,type:'def_plus'},
{q:0,r:-3,type:'def_plus'},{q:0,r:-2,type:'extra_spawn'},{q:0,r:-1,type:'def_plus'},
{q:0,r:0,type:'mana_pool'},{q:0,r:1,type:'atk_plus'},{q:0,r:2,type:'dagger'},
{q:0,r:3,type:'atk_plus'},{q:0,r:4,type:'plain'},{q:0,r:5,type:'spawner',owner:2},
{q:1,r:-5,type:'atk_minus'},{q:1,r:-4,type:'atk_plus'},{q:1,r:-3,type:'atk_minus'},
{q:1,r:-2,type:'atk_minus'},{q:1,r:-1,type:'atk_plus'},{q:1,r:0,type:'def_plus'},
{q:1,r:1,type:'atk_minus'},{q:1,r:2,type:'def_plus'},{q:1,r:3,type:'atk_plus'},
{q:1,r:4,type:'plain'},{q:2,r:-5,type:'plain'},{q:2,r:-4,type:'thorns'},
{q:2,r:-3,type:'def_plus'},{q:2,r:-2,type:'dagger'},{q:2,r:-1,type:'atk_minus'},
{q:2,r:0,type:'extra_spawn'},{q:2,r:1,type:'atk_minus'},{q:2,r:2,type:'thorns'},
{q:2,r:3,type:'plain'},{q:3,r:-5,type:'plain'},{q:3,r:-4,type:'atk_plus'},
{q:3,r:-3,type:'atk_plus'},{q:3,r:-2,type:'def_plus'},{q:3,r:-1,type:'atk_minus'},
{q:3,r:0,type:'def_plus'},{q:3,r:1,type:'atk_plus'},{q:3,r:2,type:'plain'},
{q:4,r:-5,type:'plain'},{q:4,r:-4,type:'plain'},{q:4,r:-3,type:'atk_plus'},
{q:4,r:-2,type:'thorns'},{q:4,r:-1,type:'atk_plus'},{q:4,r:0,type:'def_plus'},
{q:4,r:1,type:'atk_minus'},{q:5,r:-5,type:'spawner',owner:1},{q:5,r:-4,type:'plain'},
{q:5,r:-3,type:'plain'},{q:5,r:-2,type:'plain'},{q:5,r:-1,type:'atk_minus'},
{q:5,r:0,type:'extra_action'}
];

const SPAWNER_COORDS = [{q:-5,r:0}, {q:5,r:-5}, {q:0,r:5}]; // Red, Blue, Green

class Game {
  constructor(winScore = 10){
    this.winScore = winScore;
    this.tiles = new Map();
    this.troops = [];
    this.nextTroopId = 1;
    this.gameOver = false;
    this.winner = null;
    this.players = [0,1,2].map((_,i)=>({
      mana:0, actionPoints:1, spawner:SPAWNER_COORDS[i]
    }));
    BOARD_DATA.forEach(d=>{
      this.tiles.set(key(d.q,d.r), {q:d.q, r:d.r, type:d.type, occupantId:null, owner:d.owner});
    });
    this.players.forEach((p,pi)=>{
      neighbors(p.spawner.q,p.spawner.r)
        .filter(n=>this.tiles.has(key(n.q,n.r)))
        .forEach(n=>this.createTroop(pi,n.q,n.r));
    });
  }
  getTile(q,r){ return this.tiles.get(key(q,r)); }
  getTroopAt(q,r){ const t=this.getTile(q,r); if(!t||t.occupantId==null) return null; return this.troops.find(tr=>tr.id===t.occupantId)||null; }
  isEmptyTile(c){ const t=this.getTile(c.q,c.r); if(!t) return false; if(t.type==='spawner') return false; return t.occupantId==null; }
  isLocked(troop){ return LOCKING_TYPES.includes(this.getTile(troop.q,troop.r).type); }
  getStats(troop){
    const t=this.getTile(troop.q,troop.r);
    let atk=1, def=1;
    if(t.type==='atk_minus') atk-=1;
    if(t.type==='atk_plus') atk+=1;
    if(t.type==='def_plus') def+=1;
    return {atk:Math.max(atk,0), def:Math.max(def,0)};
  }
  countTiles(pi,type){ let c=0; this.troops.forEach(tr=>{ if(tr.owner===pi && this.getTile(tr.q,tr.r).type===type) c++; }); return c; }
  hasLegalMove(pi){
    return this.troops.some(tr=>tr.owner===pi && !this.isLocked(tr) &&
      neighbors(tr.q,tr.r).some(n=>this.tiles.has(key(n.q,n.r)) && this.isEmptyTile(n)));
  }
  hasLegalAttack(pi){
    return this.troops.some(tr=>tr.owner===pi && !this.isLocked(tr) &&
      neighbors(tr.q,tr.r).some(n=>{ const e=this.getTroopAt(n.q,n.r); return e && e.owner!==pi; }));
  }
  daggerAvailable(pi){ return this.countTiles(pi,'dagger')>0 && this.troops.filter(t=>t.owner===pi).length>=3; }
  createTroop(owner,q,r){
    const t=this.getTile(q,r);
    const troop={id:this.nextTroopId++, owner, q, r};
    t.occupantId=troop.id;
    this.troops.push(troop);
    return troop;
  }
  destroyTroop(troop){
    const idx=this.troops.indexOf(troop);
    if(idx>=0) this.troops.splice(idx,1);
    const t=this.getTile(troop.q,troop.r);
    if(t && t.occupantId===troop.id) t.occupantId=null;
  }
  executeMove(troop,target){
    const oldTile=this.getTile(troop.q,troop.r);
    oldTile.occupantId=null;
    troop.q=target.q; troop.r=target.r;
    if(target.type==='thorns'){ this.destroyTroop(troop); return; }
    target.occupantId=troop.id;
  }
  executeAttack(attacker,defender){
    const aS=this.getStats(attacker), dS=this.getStats(defender);
    const aKills=aS.atk>=dS.def, dKills=dS.atk>=aS.def;
    if(aKills) this.destroyTroop(defender);
    if(dKills) this.destroyTroop(attacker);
  }
  chooseSpawnTileCPU(options){
    const order={extra_action:5, extra_spawn:4, atk_plus:3, def_plus:2, plain:1, atk_minus:0, thorns:-5};
    let best=options[0], bestScore=-999;
    options.forEach(o=>{ const tp=this.getTile(o.q,o.r).type; const s=order[tp]??1; if(s>bestScore){ bestScore=s; best=o; } });
    return best;
  }
  performSacrificeCPU(pi){
    const mine=this.troops.filter(t=>t.owner===pi);
    if(mine.length<3) return false;
    const sorted=[...mine].sort((a,b)=>{
      const score=t=>(this.getTile(t.q,t.r).type==='plain'?0:1)+(this.isLocked(t)?2:0);
      return score(a)-score(b);
    });
    sorted.slice(0,3).forEach(tr=>this.destroyTroop(tr));
    this.players[pi].mana++;
    this._checkWin(pi);
    return true;
  }
  _checkWin(pi){
    if(this.players[pi].mana>=this.winScore){ this.gameOver=true; this.winner=pi; }
  }
  startPhase(pi){
    const p=this.players[pi];
    p.actionPoints = 1 + this.countTiles(pi,'extra_action');
    const spawnsAllowed = 1 + this.countTiles(pi,'extra_spawn');
    for(let i=0;i<spawnsAllowed;i++){
      if(this.troops.filter(t=>t.owner===pi).length>=15) break;
      const options = neighbors(p.spawner.q,p.spawner.r).filter(n=>this.tiles.has(key(n.q,n.r)) && this.isEmptyTile(n));
      if(options.length===0) break;
      const choice = options.length===1 ? options[0] : this.chooseSpawnTileCPU(options);
      this.createTroop(pi, choice.q, choice.r);
    }
  }
  endPhase(pi){
    const manaTile=this.getTile(0,0);
    if(manaTile.occupantId!=null){
      const troop=this.troops.find(t=>t.id===manaTile.occupantId);
      if(troop && troop.owner===pi){
        this.players[pi].mana++;
        this._checkWin(pi);
      }
    }
  }
}

module.exports = { Game, key, neighbors, hexDistance, LOCKING_TYPES, UNMISSABLE_CLAIM_TYPES, BOARD_DATA };
