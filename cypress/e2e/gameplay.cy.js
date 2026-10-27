import { buildBoard, setupInitialTroops, getTile, getStats } from '../../src/board/BoardModel.js';
import { startPhase } from '../../src/systems/SpawnSystem.js';
import { executeAttack } from '../../src/systems/CombatSystem.js';
import { endPhase, executeMove } from '../../src/systems/TurnSystem.js';
import { neighbors, key } from '../../src/utils/hex.js';
import { COLOR_META, LOCKING_TYPES, TILE_INFO } from '../../src/data/gameData.js';

describe('gameplay rules in the browser', () => {
  const makePlayers = () => COLOR_META.map((color, index) => ({
    ...color,
    human: index === 0,
    mana: 0,
    actionPoints: 1
  }));

  it('builds the fixed board and gives each seat its starting troops', () => {
    const players = makePlayers();
    const tiles = buildBoard(players);
    const troops = [];
    let id = 1;

    setupInitialTroops(players, tiles, (owner, q, r) => {
      const troop = { id: id++, owner, q, r };
      troops.push(troop);
      getTile(tiles, q, r).occupantId = troop.id;
    });

    expect(tiles.size).to.equal(91);
    expect(getTile(tiles, 0, 0).type).to.equal('mana_pool');
    expect(players.map((player) => player.spawner)).to.deep.equal([
      { q: -5, r: 0 }, { q: 5, r: -5 }, { q: 0, r: 5 }
    ]);
    expect(players.map((_, owner) => troops.filter((troop) => troop.owner === owner).length)).to.deep.equal([3, 3, 3]);
  });

  it('spawns beside the home spawner, moves onto a shrine, and awards its turn bonus', async () => {
    const players = makePlayers();
    const tiles = buildBoard(players);
    const troops = [];
    let id = 1;
    setupInitialTroops(players, tiles, (owner, q, r) => {
      const troop = { id: id++, owner, q, r, sprite: { x: 0, y: 0 } };
      troops.push(troop);
      getTile(tiles, q, r).occupantId = troop.id;
    });
    const vacatedTroop = troops.find((troop) => troop.owner === 0);
    getTile(tiles, vacatedTroop.q, vacatedTroop.r).occupantId = null;
    troops.splice(troops.indexOf(vacatedTroop), 1);
    const shrine = getTile(tiles, -5, 5);
    const spawnOptions = neighbors(-5, 0).filter(({ q, r }) => tiles.has(key(q, r)) && getTile(tiles, q, r).occupantId == null && getTile(tiles, q, r).type !== 'spawner');

    const startContext = {
      players: () => players,
      countTiles: (owner, type) => troops.filter((troop) => troop.owner === owner && getTile(tiles, troop.q, troop.r).type === type).length,
      troops: () => troops,
      neighbors,
      tiles: () => tiles,
      isEmptyTile: ({ q, r }) => getTile(tiles, q, r).occupantId == null && getTile(tiles, q, r).type !== 'spawner',
      waitForSpawn: async (options) => options[0],
      createTroop: (owner, q, r) => {
        const troop = { id: id++, owner, q, r, sprite: { x: 0, y: 0 } };
        troops.push(troop);
        getTile(tiles, q, r).occupantId = troop.id;
      },
      cpuChooseSpawnTile: () => spawnOptions[0],
      sleep: async () => {}, log: () => {}, coloredName: () => 'Red', updateHUD: () => {}
    };
    await startPhase(startContext, 0);

    const spawned = troops.find((troop) => troop.owner === 0 && troop.q === spawnOptions[0].q && troop.r === spawnOptions[0].r);
    expect(spawned).to.exist;
    expect(players[0].actionPoints).to.equal(1);
    const moveFrom = getTile(tiles, -5, 4);
    const mover = { id: id++, owner: 0, q: -5, r: 4, sprite: { x: 0, y: 0 } };
    troops.push(mover);
    moveFrom.occupantId = mover.id;

    await executeMove({
      getTile: (q, r) => getTile(tiles, q, r),
      axialToPixel: (q, r) => ({ x: q, y: r }), hexSize: 1, boardX: (x) => x, boardY: (y) => y,
      moveSpritesTo: async () => {}, coloredName: () => 'Red', destroyTroop: async () => {},
      refreshLockVisual: () => {}, lockingTypes: LOCKING_TYPES, tileInfo: TILE_INFO, log: () => {}
    }, mover, shrine);

    expect(shrine.occupantId).to.equal(mover.id);
    expect(getTile(tiles, spawnOptions[0].q, spawnOptions[0].r).occupantId).to.equal(spawned.id);
    await startPhase(startContext, 0);
    expect(players[0].actionPoints).to.equal(2);
  });

  it('resolves simultaneous combat and awards mana for holding the center through end of turn', async () => {
    const players = makePlayers();
    players[0].mana = 9;
    const tiles = buildBoard(players);
    const center = getTile(tiles, 0, 0);
    const attacker = { id: 1, owner: 0, q: 0, r: 1, sprite: { x: 0, y: 0 } };
    const defender = { id: 2, owner: 1, q: 0, r: 0, sprite: { x: 0, y: 0 } };
    const centerHolder = { id: 3, owner: 0, q: -1, r: 0, sprite: { x: 0, y: 0 } };
    const troops = [attacker, defender, centerHolder];
    getTile(tiles, attacker.q, attacker.r).occupantId = attacker.id;
    center.occupantId = defender.id;
    getTile(tiles, centerHolder.q, centerHolder.r).occupantId = centerHolder.id;
    const destroyed = [];

    await executeAttack({
      getStats: (troop) => getStats(tiles, troop), log: () => {}, burst: () => {}, sleep: async () => {},
      coloredName: () => 'Clan', destroyTroop: async (troop) => {
        destroyed.push(troop.id);
        getTile(tiles, troop.q, troop.r).occupantId = null;
      }
    }, attacker, defender);

    expect(destroyed).to.have.members([attacker.id, defender.id]);
    center.occupantId = centerHolder.id;
    let gameOver = false;
    let winner = null;
    await endPhase({
      players: () => players, getTile: (q, r) => getTile(tiles, q, r), troops: () => troops,
      winScore: 10, log: () => {}, coloredName: () => 'Red', axialToPixel: () => ({ x: 0, y: 0 }),
      hexSize: 1, boardX: (x) => x, boardY: (y) => y, burst: () => {}, updateHUD: () => {},
      setGameOver: (value) => { gameOver = value; }, showVictory: (index) => { winner = index; }
    }, 0);

    expect(players[0].mana).to.equal(10);
    expect(gameOver).to.equal(true);
    expect(winner).to.equal(0);
  });
});
