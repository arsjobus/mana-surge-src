export const TILE_INFO = {
  plain:        {name:'Open Ground', desc:'No special effect. Safe to stand on.'},
  thorns:       {name:'Thorns', desc:'Deadly! Any troop that steps here is destroyed instantly.'},
  atk_minus:    {name:'Withering Shrine (−1 ATK)', desc:'Troops standing here fight with 1 less attack.'},
  atk_plus:     {name:'Fury Shrine (+1 ATK)', desc:'Troops standing here fight with 1 more attack.'},
  def_plus:     {name:'Aegis Shrine (+1 DEF)', desc:'Troops standing here defend with 1 more defense.'},
  extra_action: {name:'Surge Shrine (Extra Action)', desc:'Grants +1 action point per turn while occupied. Locks the troop in place.'},
  extra_spawn:  {name:'Growth Shrine (Extra Spawn)', desc:'Grants +1 troop spawn per turn while occupied. Locks the troop in place.'},
  dagger:       {name:'Sacrificial Dagger', desc:'While you occupy this tile, you may spend 1 action point to sacrifice 3 of your troops for 1 mana point.'},
  mana_pool:    {name:'Mana Pool', desc:'Hold this tile at the end of your turn to gain 1 mana point. Locks the troop, but it can still be attacked.'},
  spawner:      {name:'Troop Spawner', desc:'Spawns new troops onto adjacent empty tiles each turn.'}
};
export const LOCKING_TYPES = ['extra_action','extra_spawn','mana_pool'];

export const COLOR_META = Object.freeze([
  {name:'Red',   colorHex:0xff5757},
  {name:'Blue',  colorHex:0x5aa9ff},
  {name:'Green', colorHex:0x4fe08a},
 ].map(Object.freeze));
