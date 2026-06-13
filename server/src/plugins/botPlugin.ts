import { GameConstants, TeamMode } from "@common/constants";
import { Guns } from "@common/definitions/items/guns";
import { Loots } from "@common/definitions/loots";
import { PacketType } from "@common/packets/packet";
import { CircleHitbox } from "@common/utils/hitbox";
import { Geometry } from "@common/utils/math";
import { Vec, type Vector } from "@common/utils/vector";
import { type GunItem } from "../inventory/gunItem";
import { type Player } from "../objects/player";
import { GamePlugin } from "../pluginManager";

// ---------------------------------------------------------------------------
// Configuration — edit these constants to tune bot behavior
// ---------------------------------------------------------------------------

/** Returns bot count for a given team mode (env `BOT_COUNT` overrides) */
function getBotCount(teamMode: TeamMode): number {
    const env = parseInt(process.env.BOT_COUNT ?? "");
    if (env > 0) return env;
    switch (teamMode) {
        case TeamMode.Duo: return 38;    // 2 human + 38 bots = 40
        case TeamMode.Squad: return 36;  // 4 human + 36 bots = 40
        default: return 40;              // solo: 1 human + 40 bots
    }
}

/** Distance at which bots go full-auto */
const ATTACK_RANGE = 80;

/** Max engagement range — bot's absolute awareness limit */
const MAX_CHASE_RANGE = 180;

/**
 * Compute this bot's detection range based on its own scope + combat awareness.
 * - Bot's scope zoom determines base vision radius (zoom + 4)
 * - If bot was recently damaged, boost by 1.5x for 5s (combat awareness)
 * - Clamped to [60, MAX_CHASE_RANGE]
 */
function botChaseRange(data: BotData, now: number): number {
    const zoom = data.player.effectiveScope?.zoomLevel ?? 100;
    const base = zoom + 4; // player screen dim = zoom*2+8, radius = zoom+4
    // Combat awareness: recently damaged → temporary vision boost
    const combatBoost = (now - data.lastDamagedTime < 5000 && data.lastDamagedTime > 0) ? 1.5 : 1.0;
    return Math.max(60, Math.min(MAX_CHASE_RANGE, base * combatBoost));
}

/**
 * Random scope for bots — determines their detection range.
 * Scopes: 1x 15% / 2x 40% / 4x 30% / 8x 15%
 */
function randomScopeId(): string {
    const r = Math.random();
    if (r < 0.15) return "1x_scope";
    if (r < 0.55) return "2x_scope";
    if (r < 0.85) return "4x_scope";
    return "8x_scope";
}

/** Range (ms) for bot to pick a new wander direction */
const WANDER_INTERVAL_MIN = 1500;
const WANDER_INTERVAL_MAX = 4000;

/** 0-1 chance a shot lands near the target (lower = more misses) */
const AIM_ACCURACY = 0.35;

// ---------------------------------------------------------------------------
// Bot names — prefixed with `:` so players can identify them
// ---------------------------------------------------------------------------
const BOT_NAMES = [
    "Ace", "Bandit", "Clutch", "Dash", "Echo",
    "Fang", "Ghost", "Hawk", "Ion", "Jinx",
    "Kaze", "Lynx", "Mars", "Nova", "Onyx",
    "Pixel", "Quake", "Razor", "Storm", "Thorn",
    "Ultra", "Vex", "Wolf", "Xero", "Zeal",
    "Blitz", "Crash", "Drift", "Flux", "Grit",
];

// ---------------------------------------------------------------------------
// Gun whitelist — bots only get these (excludes meme / special weapons)
// ---------------------------------------------------------------------------
const BOT_GUNS = new Set([
    "ak47", "m16a4", "m4a1", "scar", "famas",
    "mp5", "ump9", "vector", "p90", "thompson",
    "remington_870", "benelli_m4", "saiga_12", "usas12",
    "glock_18c", "m1911", "deagle", "ots_38",
    "mosin", "sv98", "awm",
]);

/** Pick a random gun for a bot. Falls back to the first gun definition. */
function randomGunId(): string {
    const pool = Guns.definitions.filter(g => BOT_GUNS.has(g.idString));
    if (pool.length === 0) return Guns.definitions[0].idString;
    return pool[Math.floor(Math.random() * pool.length)].idString;
}

// Distinct skins cycled by team index — same team = same skin
const BOT_SKINS = [
    "red_tomato", "greenhorn", "blue_blood", "bubblegum", "sunset",
    "mango", "snow_cone", "floral", "solar_flare", "aquatic",
    "volcanic", "zebra", "tiger", "swiss_cheese", "full_moon",
];

// ---------------------------------------------------------------------------
// Bot brain — lightweight FSM per bot
// ---------------------------------------------------------------------------

type BotState = "wander" | "chase" | "attack";

interface BotData {
    player: Player;
    state: BotState;
    prevState: BotState;
    /** Movement direction (unit vector) */
    dir: Vector;
    /** Timestamp (ms) for next wander direction change */
    nextDirChange: number;
    /** Consecutive ticks with negligible movement (stuck detection) */
    stuckTicks: number;
    /** Alternate direction when stuck (perpendicular to desired path) */
    stuckDir: number; // 1 = right, -1 = left
    prevPos: Vector;
    /** Last health value — used to detect incoming damage */
    lastHealth: number;
    /** Timestamp (ms) of last time bot took damage */
    lastDamagedTime: number;
    /** Timestamp (ms) of last regen application */
    lastRegenTime: number;
    /** Track if bot needed obstacle steering this period */
    pathSteered: boolean;
    /** Timestamp until current dodge direction holds */
    dodgeUntil: number;
    /** Current dodge direction: 1=right, -1=left */
    dodgeDir: number;
    /** Tracks if a dodge move was corrected by steerClear this period */
    dodgeBlocked: boolean;
    /** Timestamp when wall-sliding started (0 = not sliding) */
    wallSlideSince: number;
    /** Timestamp when bot entered chase/attack (prevents instant retreat) */
    fightStartedAt: number;
}

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

export default class BotPlugin extends GamePlugin {
    private readonly _bots = new Set<BotData>();
    private _spawned = false;
    private _stopped = false;
    private _spawnCount = 0;

    protected override initListeners(): void {
        // Only activate when bot mode is explicitly enabled
        if (!process.env.BOT_MODE) return;

        this.on("game_created", this._onGameCreated.bind(this));
        this.on("game_tick", this._onTick.bind(this));
        this.on("game_end", this._onGameEnd.bind(this));
        this.on("player_did_die", this._onPlayerDie.bind(this));

        // Fallback: if the plugin loaded after game_created already fired,
        // spawn bots on the first tick
        this.on("game_tick", this._spawnOnFirstTick.bind(this));
    }

    // -----------------------------------------------------------------------
    // Event handlers
    // -----------------------------------------------------------------------

    private _onGameCreated(_game: object): void {
        this._spawnBots();
    }

    /**
     * Guaranteed to run once - either via game_created (if plugin loaded in time)
     * or via first game_tick (fallback for when async plugin loading is slow)
     */
    private _spawnOnFirstTick(): void {
        if (!this._spawned) this._spawnBots();
    }

    private _spawnBots(): void {
        if (this._spawned) return;
        this._spawned = true;

        const botCount = getBotCount(this.game.teamMode);
        this.game.log(`[BotPlugin] Spawning ${botCount} bots (${TeamMode[this.game.teamMode]} mode)...`);

        // Stagger bot creation to avoid all spawning at the same position
        const spawnNext = (i: number): void => {
            if (this._stopped || i >= botCount) {
                if (!this._stopped) {
                    this.game.log(`[BotPlugin] ${this._bots.size} bots active`);

                    // ---- recommended config for minTeamsToStart ----
                    if (this.game.isTeamMode) {
                        const teamSize = this.game.teamMode as number;
                        const botTeams = Math.ceil(botCount / teamSize);
                        const recommended = botTeams + 1;
                        this.game.log(`[BotPlugin] Set "minTeamsToStart": ${recommended} in config.json (${botTeams} bot teams + 1 human team)`);
                    } else {
                        this.game.log(`[BotPlugin] Set "minTeamsToStart": ${botCount + 1} in config.json (${botCount} bots + 1 human)`);
                    }

                    // ---- test log: team distribution summary ----
                    // ---- test log: gear distribution ----
                    let gearL1Total = 0;
                    let gearL2Total = 0;
                    let gearL3Total = 0;
                    for (const d of this._bots) {
                        const b = d.player;
                        const lv = b.inventory.helmet?.level ?? 0;
                        if (lv === 1) gearL1Total++;
                        else if (lv === 2) gearL2Total++;
                        else if (lv >= 3) gearL3Total++;
                    }
                    process.stdout.write(`[BOT GEAR] Summary: L1=${gearL1Total} L2=${gearL2Total} L3=${gearL3Total} (${this._bots.size} bots)\n`);

                    if (this.game.isTeamMode) {
                        const teamMap = new Map<number, string[]>();
                        for (const d of this._bots) {
                            const tid = d.player.teamID ?? -1;
                            if (!teamMap.has(tid)) teamMap.set(tid, []);
                            teamMap.get(tid)!.push(d.player.name);
                        }
                        const sizes = [...teamMap.values()].map(a => a.length);
                        const min = Math.min(...sizes);
                        const max = Math.max(...sizes);
                        process.stdout.write(`[BOT TEAM] Distribution: ${teamMap.size} teams, sizes min=${min} max=${max}\n`);
                        for (const [tid, names] of teamMap) {
                            process.stdout.write(`[BOT TEAM]   team ${tid}: [${names.join(", ")}]\n`);
                        }
                    }
                }
                return;
            }

            const bot = this._createBot(`${BOT_NAMES[i % BOT_NAMES.length]}${i}`);
            if (!bot) {
                this.game.log(`[BotPlugin] Failed to create bot #${i} — game may be full`);
                return;
            }

            // Next bot after 100ms so they get different spawn positions
            setTimeout(() => spawnNext(i + 1), 100);
        };

        spawnNext(0);
    }

    private _logTick = 0;
    private _noHumansSince = 0;
    private _onTick(): void {
        const now = Date.now();

        // Check if any human players remain (name doesn't start with ":")
        let hasHumans = false;
        for (const p of this.game.connectedPlayers) {
            if (!p.name.startsWith(":")) { hasHumans = true; break; }
        }
        if (!hasHumans) {
            if (this._noHumansSince === 0) {
                this._noHumansSince = now;
            } else if (now - this._noHumansSince > 5000) {
                // 5 seconds with no humans — end the game
                this.game.log("[BotPlugin] No human players remaining — ending game");
                this.game.kill();
                this._noHumansSince = 0;
                return;
            }
        } else {
            this._noHumansSince = 0;
        }

        // Heartbeat: engagement summary every 80 ticks (~2s), all modes
        if (++this._logTick % 80 === 0) {
            let chaseCount = 0;
            let attackCount = 0;
            let wanderCount = 0;
            let chaseShots = 0;
            for (const data of this._bots) {
                const b = data.player;
                if (b.dead || !b.joined) continue;
                if (data.state === "attack") { attackCount++; chaseShots++; }
                else if (data.state === "chase") chaseCount++;
                else wanderCount++;
            }
            process.stdout.write(`[BOT ENGAGE] chase=${chaseCount}(shooting) attack=${attackCount}(shooting) wander=${wanderCount}\n`);
        }

        // Heartbeat: team coordination stats every 120 ticks (~3s)
        if (this._logTick % 120 === 0 && this.game.isTeamMode) {
            let followingTeammate = 0;
            let soloWander = 0;
            let sharedTarget = 0;
            let totalLiving = 0;
            for (const data of this._bots) {
                const b = data.player;
                if (b.dead || !b.joined) continue;
                totalLiving++;
                if (data.state === "wander") {
                    const mate = this._findNearestTeammate(b);
                    if (mate) {
                        const d = Geometry.distance(b.position, mate.position);
                        if (d < 80) soloWander++;
                        else followingTeammate++;
                    } else {
                        soloWander++;
                    }
                }
                    if (data.state === "attack") {
                    const mate = this._findNearestTeammate(b, 50);
                    if (mate && mate.attacking) sharedTarget++;
                }
                if (data.state === "chase" && b.attacking) chaseShooting++;
            }
            let chaseShooting = 0;
            let dodgeBlocked = 0;
            let pathSteered = 0;
            let regenActive = 0;
            let fullHp = 0;
            let damaged = 0;
            for (const data of this._bots) {
                const b = data.player;
                if (b.dead || !b.joined) continue;
                if (b.health >= b.maxHealth) fullHp++;
                else if (data.lastRegenTime > 0) regenActive++;
                else damaged++;
                if (data.pathSteered) pathSteered++;
                if (data.dodgeBlocked) dodgeBlocked++;
                data.pathSteered = false; // reset for next period
                data.dodgeBlocked = false;
            }
            let gearL1 = 0;
            let gearL2 = 0;
            let gearL3 = 0;
            for (const data of this._bots) {
                const b = data.player;
                if (b.dead || !b.joined) continue;
                const lv = b.inventory.helmet?.level ?? 0;
                if (lv === 1) gearL1++;
                else if (lv === 2) gearL2++;
                else if (lv >= 3) gearL3++;
            }
            process.stdout.write(`[BOT TEAM STATS] living=${totalLiving} closeWander=${soloWander} followingMate=${followingTeammate} sharedAttack=${sharedTarget} regen=${regenActive} damaged=${damaged} fullHP=${fullHp} skirmish=${chaseShooting} steering=${pathSteered} dodgeBlocked=${dodgeBlocked} gearL1=${gearL1} L2=${gearL2} L3=${gearL3}\n`);
        }

        // Heartbeat: log attacking bots every 40 ticks (~1s)
        if (this._logTick % 40 === 0) {
            let attackingCount = 0;
            for (const data of this._bots) {
                if (data.state !== "attack" && data.state !== "chase") continue;
                const b = data.player;
                if (b.dead) continue;
                const w = b.inventory.activeWeapon;
                process.stdout.write(`[BOT HB] ${b.name} state=${data.state} attacking=${b.attacking} started=${b.startedAttacking} weapon=slot${b.inventory.activeWeaponIndex}:${w?.definition.idString ?? "none"} ammo=${(w as any)?.ammo ?? "?"} pos=(${b.position.x.toFixed(0)},${b.position.y.toFixed(0)})\n`);
                attackingCount++;
                if (attackingCount >= 5) break; // limit spam
            }
        }

        for (const data of this._bots) {
            const bot = data.player;
            if (bot.dead || !bot.joined) continue;

            // ---- health regeneration (5 HP/s after 5s out of combat) ----
            if (bot.health < bot.maxHealth) {
                if (bot.health < data.lastHealth) {
                    // Took damage: reset timers
                    data.lastDamagedTime = now;
                    data.lastRegenTime = 0;
                }
                data.lastHealth = bot.health;

                if (data.lastRegenTime === 0) {
                    // Start tracking regen once the cooldown expires
                    if (now - data.lastDamagedTime >= 5000) {
                        data.lastRegenTime = now;
                        process.stdout.write(`[BOT REGEN] ${bot.name} start regen (HP=${bot.health.toFixed(0)})\n`);
                    }
                }

                if (data.lastRegenTime > 0) {
                    const elapsed = (now - data.lastRegenTime) / 1000;
                    const regenAmount = 5 * elapsed; // 5 HP/s
                    if (regenAmount >= 1) {
                        bot.health = Math.min(bot.maxHealth, bot.health + regenAmount);
                        data.lastRegenTime = now;
                        process.stdout.write(`[BOT REGEN] ${bot.name} +${regenAmount.toFixed(1)} HP → ${bot.health.toFixed(0)}/${bot.maxHealth}\n`);
                        if (bot.health >= bot.maxHealth) {
                            process.stdout.write(`[BOT REGEN] ${bot.name} fully healed\n`);
                        }
                    }
                }
            } else {
                data.lastHealth = bot.health;
            }

            // ---- find nearest enemy (human or other bot) ----
            let nearestDist = Infinity;
            let nearestEnemy: Player | null = null;

            for (const other of this.game.livingPlayers) {
                // Skip self. Skip teammates only in team modes.
                if (other === bot) continue;
                if (this.game.isTeamMode && other.teamID === bot.teamID) continue;
                const d = Geometry.distance(bot.position, other.position);
                if (d < nearestDist) {
                    nearestDist = d;
                    nearestEnemy = other;
                }
            }

            // ---- team coordination: share targets ----
            // If no enemy in chase range, check if a nearby teammate is fighting
            const chaseLimit = botChaseRange(data, now);
            if ((!nearestEnemy || nearestDist > chaseLimit) && this.game.isTeamMode) {
                const teamTarget = this._findTeammateTarget(bot);
                if (teamTarget) {
                    nearestEnemy = teamTarget;
                    nearestDist = Geometry.distance(bot.position, teamTarget.position);
                    process.stdout.write(`[BOT TEAM] ${bot.name} shared target ${teamTarget.name} from teammate (dist=${nearestDist.toFixed(0)})\n`);
                }
            }

            // ---- decide state ----
            if (nearestEnemy && nearestDist < ATTACK_RANGE) {
                data.state = "attack";
            } else if (nearestEnemy && nearestDist < botChaseRange(data, now)) {
                data.state = "chase";
            } else {
                data.state = "wander";
            }

            // ---- handle state transitions ----
            const enteredAttack = data.state === "attack" && data.prevState !== "attack";
            const enteredChase = data.state === "chase" && data.prevState !== "chase";
            const leftCombat = data.state === "wander" && data.prevState !== "wander";
            const leftAttack = data.state !== "attack" && data.prevState === "attack";
            data.prevState = data.state;

            if (enteredAttack || enteredChase) {
                if (data.fightStartedAt === 0) data.fightStartedAt = now;
                if (enteredAttack) {
                    process.stdout.write(`[BOT] ${bot.name} entered ATTACK — enemy=${nearestEnemy?.name} dist=${nearestDist.toFixed(0)}\n`);
                }
                if (enteredChase) {
                    const visRange = botChaseRange(data, now);
                    process.stdout.write(`[BOT] ${bot.name} entered CHASE — enemy=${nearestEnemy?.name} dist=${nearestDist.toFixed(0)} range=${visRange.toFixed(0)} scope=${bot.effectiveScope?.idString ?? "?"}${data.lastDamagedTime > 0 && now - data.lastDamagedTime < 5000 ? " BOOSTED" : ""} (potshots)\n`);
                }
            }
            if (leftCombat) {
                data.fightStartedAt = 0; // reset fight timer
            }
            const leftChase = data.state !== "chase" && data.prevState === "chase";
            if (leftAttack || leftChase) {
                bot.attacking = false;
                bot.stoppedAttacking = true;
                if (leftAttack) {
                    process.stdout.write(`[BOT] ${bot.name} left ATTACK — now ${data.state}\n`);
                }
            }

            if (data.state === "attack" || data.state === "chase") {
                // Fire in both attack and chase — cooldown prevents over-firing
                bot.attacking = true;
                bot.startedAttacking = true;
            }

            // ---- execute movement ----
            switch (data.state) {
                case "attack":
                    this._doAttack(data, nearestEnemy!);
                    break;
                case "chase":
                    this._doChase(data, nearestEnemy!);
                    break;
                case "wander":
                    this._doWander(data, now);
                    break;
            }

            // ---- tactical decision: retreat vs cover vs dodge ----
            if (nearestEnemy && data.state !== "wander") {
                const hpLow = bot.health < bot.maxHealth * 0.5 && bot.health < nearestEnemy.health && now - data.fightStartedAt > 3000;
                const wpn = bot.inventory.activeWeapon as GunItem | undefined;
                const noAmmo = wpn && wpn.ammo <= 1;

                if (hpLow || noAmmo) {
                    this._doRetreat(data, nearestEnemy);
                    if (noAmmo && this._logTick % 80 === 0) {
                        process.stdout.write(`[BOT AMMO] ${bot.name} retreating — ammo=${wpn?.ammo ?? "?"} weapon=${wpn?.definition.idString ?? "?"}\n`);
                    }
                } else if (now - data.lastDamagedTime < 3000) {
                    // Recently hit — seek cover instead of open dodge
                    this._seekCover(data, nearestEnemy);
                }
            }

            // ---- proactive obstacle avoidance (raycast-based) ----
            this._steerClear(data);

            // ---- strafe around obstacles (fallback) ----
            this._strafeIfStuck(data);

            // ---- avoid gas — bias toward map center ----
            this._avoidGas(bot);
        }
    }

    private _onPlayerDie({ player }: { player: Player }): void {
        for (const data of this._bots) {
            if (data.player === player) {
                this._bots.delete(data);
                return;
            }
        }
    }

    private _onGameEnd(): void {
        this._stopped = true;
        this._bots.clear();
        this.game.log("[BotPlugin] Cleaned up — game ended");
    }

    // -----------------------------------------------------------------------
    // Bot lifecycle
    // -----------------------------------------------------------------------

    private _createBot(shortName: string): Player | undefined {
        const game = this.game;

        // Step 1 — create player shell (no socket = bot)
        const bot = game.addPlayer();
        if (!bot) return undefined;

        // Step 2 — simulate join with Target Practice skin and `:`-prefixed name
        game.activatePlayer(bot, {
            type: PacketType.Join,
            name: `:${shortName}`,
            isMobile: false,
            skin: Loots.fromString(BOT_SKINS[(this._spawnCount++) % BOT_SKINS.length]),
            emotes: Array.from({ length: 8 }, () => undefined),
            protocolVersion: GameConstants.protocolVersion,
        });

        // Step 3 — give a random gun with infinite ammo
        const gunId = randomGunId();
        const gunDef = Guns.fromString(gunId);
        bot.inventory.addOrReplaceWeapon(0, gunId);
        const weapon = bot.inventory.getWeapon(0) as GunItem;
        weapon.ammo = gunDef.capacity;
        bot.inventory.items.setItem(gunDef.ammoType, Infinity);

        // Step 3.5 — equip random armor & backpack (L1 45% / L2 40% / L3 15%)
        const gearLevel = (): number => {
            const r = Math.random();
            if (r < 0.15) return 3;
            if (r < 0.55) return 2;
            return 1;
        };
        const helmets = ["basic_helmet", "regular_helmet", "tactical_helmet"];
        const vests = ["basic_vest", "regular_vest", "tactical_vest"];
        const packs = ["basic_pack", "regular_pack", "tactical_pack"];
        const helIdx = gearLevel() - 1;
        const vestIdx = gearLevel() - 1;
        const packIdx = gearLevel() - 1;
        bot.inventory.helmet = Loots.fromString(helmets[helIdx]);
        bot.inventory.vest = Loots.fromString(vests[vestIdx]);
        bot.inventory.backpack = Loots.fromString(packs[packIdx]);
        bot.dirty.items = true;
        bot.setDirty();

        // Step 3.6 — equip random scope (determines bot's vision range)
        const scopeId = randomScopeId();
        bot.inventory.scope = scopeId;
        bot.effectiveScope = scopeId;

        process.stdout.write(`[BOT GEAR] ${bot.name} helmet=${helmets[helIdx]}(L${helIdx + 1}) vest=${vests[vestIdx]}(L${vestIdx + 1}) backpack=${packs[packIdx]}(L${packIdx + 1}) scope=${scopeId}\n`);

        // Step 4 — remove spawn protection
        bot.disableInvulnerability();

        // Step 5 — store bot metadata
        this._bots.add({
            player: bot,
            state: "wander",
            prevState: "wander",
            dir: Vec(1, 0),
            nextDirChange: 0,
            stuckTicks: 0,
            stuckDir: 1,
            prevPos: Vec.clone(bot.position),
            lastHealth: bot.health,
            lastDamagedTime: 0,
            lastRegenTime: 0,
            pathSteered: false,
            dodgeUntil: 0,
            dodgeDir: 1,
            dodgeBlocked: false,
            wallSlideSince: 0,
            fightStartedAt: 0,
        } as BotData);

        // ---- test log: team assignment ----
        if (this.game.isTeamMode) {
            process.stdout.write(`[BOT TEAM] ${bot.name} → team ${bot.teamID}\n`);
        }

        return bot;
    }

    // -----------------------------------------------------------------------
    // AI behaviors
    // -----------------------------------------------------------------------

    private _doAttack(data: BotData, enemy: Player): void {
        const bot = data.player;
        // Aim at enemy with small jitter — smooth, not wild
        const dx = enemy.position.x - bot.position.x;
        const dy = enemy.position.y - bot.position.y;
        const jitter = (Math.random() - 0.5) * (1 - AIM_ACCURACY) * 0.3; // ±0.07 rad ≈ ±4°
        bot.rotation = Math.atan2(dy, dx) + jitter;

        // Move toward a point slightly offset from the enemy — avoid stacking
        let offsetAngle = bot.rotation + Math.PI * 0.3; // offset ~54°
        let offsetDist = 15 + Math.random() * 20;

        // ---- team coordination: spread out if teammate is attacking same enemy ----
        if (this.game.isTeamMode) {
            const mate = this._findNearestTeammate(bot, 35);
            if (mate && mate.attacking) {
                // Alternate the offset side to flank from different angles
                offsetAngle = bot.rotation + Math.PI * 0.5 * (data.stuckDir || 1);
                offsetDist = 18 + Math.random() * 25;
                if (this._logTick % 80 === 0) {
                    process.stdout.write(`[BOT TEAM] ${bot.name} flanking with teammate ${mate.name}\n`);
                }
            }
        }

        // ---- dodge: add tangential strafe to avoid being an easy target ----
        const now = Date.now();
        if (now >= data.dodgeUntil) {
            data.dodgeDir = Math.random() < 0.5 ? 1 : -1;
            data.dodgeUntil = now + 600 + Math.random() * 1000;
        }
        const perpX = -(dy / (Math.sqrt(dx * dx + dy * dy) || 1)) * (12 + Math.random() * 20) * data.dodgeDir;
        const perpY = (dx / (Math.sqrt(dx * dx + dy * dy) || 1)) * (12 + Math.random() * 20) * data.dodgeDir;

        const tx = enemy.position.x + Math.cos(offsetAngle) * offsetDist + perpX;
        const ty = enemy.position.y + Math.sin(offsetAngle) * offsetDist + perpY;
        this._moveToward(bot, Vec(tx, ty));
    }

    private _doChase(data: BotData, enemy: Player): void {
        const bot = data.player;
        const now = Date.now();
        const dx = enemy.position.x - bot.position.x;
        const dy = enemy.position.y - bot.position.y;
        const dist = Math.sqrt(dx * dx + dy * dy) || 1;
        // Potshots while chasing — ~±15° jitter (much less accurate than close-range attack ±6°)
        const chaseJitter = (Math.random() - 0.5) * 0.5;
        bot.rotation = Math.atan2(dy, dx) + chaseJitter;

        // Pick a new dodge direction every 0.8-2s
        if (now >= data.dodgeUntil) {
            data.dodgeDir = Math.random() < 0.5 ? 1 : -1;
            data.dodgeUntil = now + 800 + Math.random() * 1200;
        }

        // Base target: stop 20 units from enemy
        let tx = enemy.position.x - (dx / dist) * 20;
        let ty = enemy.position.y - (dy / dist) * 20;

        // Add tangential displacement (perpendicular to enemy direction)
        const dodgeStrength = 20 + Math.random() * 35; // how far to strafe
        const perpX = -(dy / dist) * dodgeStrength * data.dodgeDir;
        const perpY = (dx / dist) * dodgeStrength * data.dodgeDir;

        tx += perpX;
        ty += perpY;

        if (this._logTick % 100 === 0) {
            process.stdout.write(`[BOT DODGE] ${bot.name} chase zigzag ${data.dodgeDir > 0 ? "right" : "left"} offset=${dodgeStrength.toFixed(0)}\n`);
        }

        this._moveToward(bot, Vec(tx, ty));
    }

    private _doWander(data: BotData, now: number): void {
        const bot = data.player;

        // Pick a new random direction, vector-blended toward gas center
        if (now >= data.nextDirChange) {
            const gas = this.game.gas;
            const toCenterX = gas.currentPosition.x - bot.position.x;
            const toCenterY = gas.currentPosition.y - bot.position.y;
            const dist = Math.sqrt(toCenterX * toCenterX + toCenterY * toCenterY) || 1;

            // Unit vector toward center
            const cx = toCenterX / dist;
            const cy = toCenterY / dist;

            // Random unit vector
            const randAngle = Math.random() * Math.PI * 2;
            const rx = Math.cos(randAngle);
            const ry = Math.sin(randAngle);

            // Blend: closer to center = more random, farther = more toward center
            const t = Math.min(dist / 500, 1); // 0 at center, 1 at 500+ units away
            let bx = cx * t + rx * (1 - t);
            let by = cy * t + ry * (1 - t);

            // ---- team coordination: lean toward nearest teammate when far away ----
            if (this.game.isTeamMode) {
                const mate = this._findNearestTeammate(bot);
                if (mate) {
                    const mateDist = Geometry.distance(bot.position, mate.position);
                    if (mateDist > 80) {
                        const mx = mate.position.x - bot.position.x;
                        const my = mate.position.y - bot.position.y;
                        const mlen = Math.sqrt(mx * mx + my * my) || 1;
                        // Blend 40% toward teammate
                        bx = bx * 0.6 + (mx / mlen) * 0.4;
                        by = by * 0.6 + (my / mlen) * 0.4;
                        if (this._logTick % 100 === 0) {
                            process.stdout.write(`[BOT TEAM] ${bot.name} following teammate ${mate.name} (dist=${mateDist.toFixed(0)})\n`);
                        }
                    }
                }
            }

            const blen = Math.sqrt(bx * bx + by * by) || 1;

            data.dir = Vec(bx / blen, by / blen);
            data.nextDirChange = now + WANDER_INTERVAL_MIN + Math.random() * (WANDER_INTERVAL_MAX - WANDER_INTERVAL_MIN);
        }

        bot.movement.up = data.dir.y < 0;
        bot.movement.down = data.dir.y > 0;
        bot.movement.left = data.dir.x < 0;
        bot.movement.right = data.dir.x > 0;

        bot.rotation = Math.atan2(data.dir.y, data.dir.x);
    }

    /**
     * Low-HP retreat: move away from enemy while still shooting.
     * Retreats toward gas center to avoid dying to the storm.
     */
    private _doRetreat(data: BotData, enemy: Player): void {
        const bot = data.player;
        const dx = enemy.position.x - bot.position.x;
        const dy = enemy.position.y - bot.position.y;
        const dist = Math.sqrt(dx * dx + dy * dy) || 1;

        // Face enemy and keep shooting (less accurate while retreating)
        const panicJitter = (Math.random() - 0.5) * 0.6; // ±0.3 rad ≈ ±17°
        bot.rotation = Math.atan2(dy, dx) + panicJitter;
        bot.attacking = true;
        bot.startedAttacking = true;

        // Retreat direction: away from enemy (0.7) + toward gas center (0.3)
        const gas = this.game.gas;
        let retreatX = -dx / dist; // away from enemy
        let retreatY = -dy / dist;

        if (gas) {
            const gx = gas.currentPosition.x - bot.position.x;
            const gy = gas.currentPosition.y - bot.position.y;
            const glen = Math.sqrt(gx * gx + gy * gy) || 1;
            retreatX = retreatX * 0.7 + (gx / glen) * 0.3;
            retreatY = retreatY * 0.7 + (gy / glen) * 0.3;
        }

        // Add dodge zigzag
        if (Date.now() >= data.dodgeUntil) {
            data.dodgeDir = Math.random() < 0.5 ? 1 : -1;
            data.dodgeUntil = Date.now() + 500 + Math.random() * 800;
        }
        const perpX = -retreatY * (15 + Math.random() * 25) * data.dodgeDir;
        const perpY = retreatX * (15 + Math.random() * 25) * data.dodgeDir;

        const blen = Math.sqrt(retreatX * retreatX + retreatY * retreatY) || 1;
        bot.movement.up = ((retreatY / blen) + perpY) < -0.05;
        bot.movement.down = ((retreatY / blen) + perpY) > 0.05;
        bot.movement.left = ((retreatX / blen) + perpX) < -0.05;
        bot.movement.right = ((retreatX / blen) + perpX) > 0.05;

        if (this._logTick % 100 === 0) {
            process.stdout.write(`[BOT RETREAT] ${bot.name} HP=${bot.health.toFixed(0)}/${bot.maxHealth} retreating from ${enemy.name}\n`);
        }
    }

    // -----------------------------------------------------------------------
    // Teammate coordination
    // -----------------------------------------------------------------------

    /** Find the nearest teammate within maxDist (unlimited if omitted). Returns null in solo. */
    private _findNearestTeammate(bot: Player, maxDist?: number): Player | null {
        if (!this.game.isTeamMode) return null;
        let nearest: Player | null = null;
        let nearestDist = maxDist ?? Infinity;
        for (const other of this.game.livingPlayers) {
            if (other === bot || other.teamID !== bot.teamID || other.dead) continue;
            const d = Geometry.distance(bot.position, other.position);
            if (d < nearestDist) {
                nearestDist = d;
                nearest = other;
            }
        }
        return nearest;
    }

    /** If a nearby teammate is attacking someone, return that enemy so this bot joins in. */
    private _findTeammateTarget(bot: Player): Player | null {
        if (!this.game.isTeamMode) return null;
        for (const mate of this.game.livingPlayers) {
            if (mate === bot || mate.teamID !== bot.teamID || mate.dead) continue;
            if (mate.attacking) {
                // Find who this teammate is aiming at
                let closestEnemy: Player | null = null;
                let closestDist = ATTACK_RANGE * 2;
                for (const other of this.game.livingPlayers) {
                    if (other === mate) continue;
                    if (this.game.isTeamMode && other.teamID === mate.teamID) continue;
                    const d = Geometry.distance(mate.position, other.position);
                    if (d < closestDist) {
                        closestDist = d;
                        closestEnemy = other;
                    }
                }
                if (closestEnemy) return closestEnemy;
            }
        }
        return null;
    }

    // -----------------------------------------------------------------------
    // Helpers
    // -----------------------------------------------------------------------

    /**
     * Find the best cover position near the bot that blocks enemy LOS.
     * Returns null if no suitable cover within 40 units.
     */
    private _findCover(bot: Player, enemy: Player): Vector | null {
        const query = new CircleHitbox(40, bot.position);
        const nearby = this.game.grid.intersectsHitbox(query);

        let best: Vector | null = null;
        let bestScore = -Infinity;

        for (const obj of nearby) {
            if (!obj.isObstacle || obj.dead) continue;
            if (!(obj as any).collidable) continue;

            const ox = obj.position.x;
            const oy = obj.position.y;
            const dx = ox - enemy.position.x;
            const dy = oy - enemy.position.y;
            const edist = Math.sqrt(dx * dx + dy * dy) || 1;

            // Cover point: far side of obstacle from enemy
            const coverX = ox + (dx / edist) * 8;
            const coverY = oy + (dy / edist) * 8;
            const coverVec = Vec(coverX, coverY);

            const distToBot = Geometry.distance(bot.position, coverVec);
            if (distToBot > 30) continue; // too far to reach quickly

            // Score: actual LOS block beats just being behind something
            const blocksLos = obj.hitbox.intersectsLine(enemy.position, coverVec) !== null;
            const score = (blocksLos ? 100 : 30) - distToBot;
            if (score > bestScore) {
                bestScore = score;
                best = coverVec;
            }
        }

        return best;
    }

    /**
     * Try to move behind cover. Returns true if cover was found and movement applied.
     * While moving to cover, bot still faces the enemy to shoot.
     */
    private _seekCover(data: BotData, enemy: Player): boolean {
        const cover = this._findCover(data.player, enemy);
        if (!cover) return false;

        this._moveToward(data.player, cover);
        if (this._logTick % 80 === 0) {
            process.stdout.write(`[BOT COVER] ${data.player.name} → cover (${cover.x.toFixed(0)},${cover.y.toFixed(0)})\n`);
        }
        return true;
    }

    /**
     * Proactive obstacle avoidance using raycasting.
     * Checks if the bot's intended path is blocked and steers to an
     * alternate direction BEFORE hitting the obstacle.
     */
    private _steerClear(data: BotData): void {
        const bot = data.player;
        data.pathSteered = false;

        // Determine intended movement direction from input flags
        let dirX = 0, dirY = 0;
        if (bot.movement.right) dirX += 1;
        if (bot.movement.left) dirX -= 1;
        if (bot.movement.down) dirY += 1;
        if (bot.movement.up) dirY -= 1;
        if (dirX === 0 && dirY === 0) return;

        const len = Math.sqrt(dirX * dirX + dirY * dirY);
        const nx = dirX / len;
        const ny = dirY / len;

        const lookAhead = 12;
        const endX = bot.position.x + nx * lookAhead;
        const endY = bot.position.y + ny * lookAhead;
        const endPos = Vec(endX, endY);

        // Broad-phase: query obstacles in a circle covering the look-ahead path
        const queryRadius = lookAhead + 5;
        const queryHitbox = new CircleHitbox(queryRadius, bot.position);
        const nearby = this.game.grid.intersectsHitbox(queryHitbox);

        // Check if any collidable obstacle blocks the path
        let blocked = false;
        for (const obj of nearby) {
            if (!obj.isObstacle || obj.dead) continue;
            const obs = obj as any;
            if (obs.collidable === false) continue;
            if (obj.hitbox.intersectsLine(bot.position, endPos)) {
                blocked = true;
                break;
            }
        }

        if (!blocked) {
            data.wallSlideSince = 0; // path cleared — reset slide timer
            return;
        }

        data.pathSteered = true;

        // Track if dodge pushed bot toward obstacle (chase/attack states)
        if (data.state !== "wander") {
            data.dodgeBlocked = true;
        }

        // Path blocked — try a fan of alternate angles
        const baseAngle = Math.atan2(ny, nx);
        const fanOffsets = [Math.PI / 6, -Math.PI / 6, Math.PI / 4, -Math.PI / 4, Math.PI / 3, -Math.PI / 3, Math.PI / 2, -Math.PI / 2];

        for (const offset of fanOffsets) {
            const angle = baseAngle + offset;
            const tx = Math.cos(angle);
            const ty = Math.sin(angle);
            const testEnd = Vec(bot.position.x + tx * lookAhead, bot.position.y + ty * lookAhead);

            let testBlocked = false;
            for (const obj of nearby) {
                if (!obj.isObstacle || obj.dead) continue;
                const obs = obj as any;
                if (obs.collidable === false) continue;
                if (obj.hitbox.intersectsLine(bot.position, testEnd)) {
                    testBlocked = true;
                    break;
                }
            }

            if (!testBlocked) {
                data.wallSlideSince = 0; // clear wall-slide timer
                bot.movement.up = ty < -0.1;
                bot.movement.down = ty > 0.1;
                bot.movement.left = tx < -0.1;
                bot.movement.right = tx > 0.1;
                // Log: steering to alternate angle
                if (this._logTick % 60 === 0) {
                    const deg = Math.round(offset * 180 / Math.PI);
                    process.stdout.write(`[BOT PATH] ${bot.name} steer ${deg > 0 ? "+" : ""}${deg}° to avoid obstacle\n`);
                }
                return;
            }
        }

        // All fan directions blocked — slide along wall using collision normal
        for (const obj of nearby) {
            if (!obj.isObstacle || obj.dead) continue;
            const obs = obj as any;
            if (obs.collidable === false) continue;
            const hit = obj.hitbox.intersectsLine(bot.position, endPos);
            if (hit && hit.normal) {
                // Track wall-sliding duration
                if (data.wallSlideSince === 0) data.wallSlideSince = Date.now();
                const slideDuration = Date.now() - data.wallSlideSince;

                // If sliding same wall for > 2s, reverse to escape
                if (slideDuration > 2000) {
                    data.wallSlideSince = 0;
                    const rx = -nx;
                    const ry = -ny;
                    bot.movement.up = ry < -0.1;
                    bot.movement.down = ry > 0.1;
                    bot.movement.left = rx < -0.1;
                    bot.movement.right = rx > 0.1;
                    process.stdout.write(`[BOT PATH] ${bot.name} wall-escape — reversing after ${(slideDuration / 1000).toFixed(1)}s\n`);
                    return;
                }

                // Project intended movement onto the wall tangent
                const dot = nx * hit.normal.x + ny * hit.normal.y;
                const sx = nx - hit.normal.x * dot;
                const sy = ny - hit.normal.y * dot;
                const slen = Math.sqrt(sx * sx + sy * sy);
                if (slen > 0.01) {
                    bot.movement.up = (sy / slen) < -0.1;
                    bot.movement.down = (sy / slen) > 0.1;
                    bot.movement.left = (sx / slen) < -0.1;
                    bot.movement.right = (sx / slen) > 0.1;
                    if (this._logTick % 80 === 0) {
                        process.stdout.write(`[BOT PATH] ${bot.name} wall-sliding (${(slideDuration / 1000).toFixed(1)}s)\n`);
                    }
                }
                return;
            }
            // No hit with normal — reset slide timer
            data.wallSlideSince = 0;
        }
        // All walls cleared — reset slide timer
        data.wallSlideSince = 0;
    }

    /** Detect obstacle collision and strafe sideways to bypass */
    private _strafeIfStuck(data: BotData): void {
        const bot = data.player;
        const moved = Geometry.distance(bot.position, data.prevPos);
        data.prevPos = Vec.clone(bot.position);

        // If the bot is actively trying to move but position barely changed
        const hasInput = bot.movement.up || bot.movement.down || bot.movement.left || bot.movement.right;
        if (!hasInput || moved > 0.5 || data.stuckTicks > 60) {
            // Moving freely or strafe timed out — reset
            data.stuckTicks = 0;
            return;
        }

        data.stuckTicks++;

        // After 0.3s stuck, override movement to strafe perpendicular
        if (data.stuckTicks >= 12) {
            // Use the bot's facing direction to determine strafe
            const side = data.stuckDir;
            const angle = bot.rotation + (Math.PI / 2) * side;
            const sx = Math.cos(angle);
            const sy = Math.sin(angle);

            // Blend strafe with a small forward component
            const fx = Math.cos(bot.rotation) * 0.2;
            const fy = Math.sin(bot.rotation) * 0.2;

            bot.movement.up = (sy + fy) < -0.1;
            bot.movement.down = (sy + fy) > 0.1;
            bot.movement.left = (sx + fx) < -0.1;
            bot.movement.right = (sx + fx) > 0.1;

            // Flip side if still stuck after 0.5s more
            if (data.stuckTicks % 20 === 0) {
                data.stuckDir = -data.stuckDir;
            }
        }
    }

    /** Set movement toward a target point */
    private _moveToward(bot: Player, target: Vector): void {
        const dx = target.x - bot.position.x;
        const dy = target.y - bot.position.y;
        const len = Math.sqrt(dx * dx + dy * dy) || 1;
        const nx = dx / len;
        const ny = dy / len;

        bot.movement.up = ny < 0;
        bot.movement.down = ny > 0;
        bot.movement.left = nx < 0;
        bot.movement.right = nx > 0;
    }

    /** Bias movement away from gas damage */
    private _avoidGas(bot: Player): void {
        const gas = this.game.gas;
        if (!gas) return;

        const center = gas.currentPosition;
        const radius = gas.currentRadius;
        if (radius <= 0) return;

        const dx = center.x - bot.position.x;
        const dy = center.y - bot.position.y;
        const dist = Math.sqrt(dx * dx + dy * dy);

        // If bot is near or past the gas edge, push hard toward center
        if (dist > radius * 0.7) {
            const nx = dx / (dist || 1);
            const ny = dy / (dist || 1);
            // Override wander/chase movement — gas survival takes priority
            bot.movement.up = ny < -0.3;
            bot.movement.down = ny > 0.3;
            bot.movement.left = nx < -0.3;
            bot.movement.right = nx > 0.3;
            // Face toward safety
            bot.rotation = Math.atan2(dy, dx);
        }
    }
}
