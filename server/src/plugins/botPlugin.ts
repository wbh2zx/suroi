import { GameConstants } from "@common/constants";
import { Guns } from "@common/definitions/items/guns";
import { Loots } from "@common/definitions/loots";
import { PacketType } from "@common/packets/packet";
import { Geometry } from "@common/utils/math";
import { Vec, type Vector } from "@common/utils/vector";
import { type GunItem } from "../inventory/gunItem";
import { type Player } from "../objects/player";
import { GamePlugin } from "../pluginManager";

// ---------------------------------------------------------------------------
// Configuration — edit these constants to tune bot behavior
// ---------------------------------------------------------------------------

/** Total bots to maintain (env `BOT_COUNT` overrides) */
const BOT_COUNT = parseInt(process.env.BOT_COUNT ?? "") || 25;

/** Distance at which bots start shooting */
const ATTACK_RANGE = 40;

/** Distance at which bots start chasing */
const CHASE_RANGE = 180;

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

        this.game.log(`[BotPlugin] Spawning ${BOT_COUNT} bots...`);

        // Stagger bot creation to avoid all spawning at the same position
        const spawnNext = (i: number): void => {
            if (this._stopped || i >= BOT_COUNT) {
                if (!this._stopped) this.game.log(`[BotPlugin] ${this._bots.size} bots active`);
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

        // Heartbeat: log attack-state bots every 40 ticks (~1s)
        if (++this._logTick % 40 === 0) {
            let attackingCount = 0;
            for (const data of this._bots) {
                if (data.state !== "attack") continue;
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

            // ---- decide state ----
            if (nearestEnemy && nearestDist < ATTACK_RANGE) {
                data.state = "attack";
            } else if (nearestEnemy && nearestDist < CHASE_RANGE) {
                data.state = "chase";
            } else {
                data.state = "wander";
            }

            // ---- handle attack state transitions ----
            const enteredAttack = data.state === "attack" && data.prevState !== "attack";
            const leftAttack = data.state !== "attack" && data.prevState === "attack";
            data.prevState = data.state;

            if (enteredAttack) {
                process.stdout.write(`[BOT] ${bot.name} entered ATTACK — enemy=${nearestEnemy?.name} dist=${nearestDist.toFixed(0)}\n`);
            }
            if (leftAttack) {
                bot.attacking = false;
                bot.stoppedAttacking = true;
                process.stdout.write(`[BOT] ${bot.name} left ATTACK — now ${data.state}\n`);
            }

            if (data.state === "attack") {
                // Trigger every tick — _bufferAttack cooldown prevents over-firing
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

            // ---- strafe around obstacles ----
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
        } as BotData);

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
        const offsetAngle = bot.rotation + Math.PI * 0.3; // offset ~54°
        const offsetDist = 15 + Math.random() * 20;
        const tx = enemy.position.x + Math.cos(offsetAngle) * offsetDist;
        const ty = enemy.position.y + Math.sin(offsetAngle) * offsetDist;
        this._moveToward(bot, Vec(tx, ty));
    }

    private _doChase(data: BotData, enemy: Player): void {
        const bot = data.player;
        const dx = enemy.position.x - bot.position.x;
        const dy = enemy.position.y - bot.position.y;
        bot.rotation = Math.atan2(dy, dx);
        // Move near enemy, not on top of them
        const dist = Math.sqrt(dx * dx + dy * dy) || 1;
        const tx = enemy.position.x - (dx / dist) * 20; // stop 20 units away
        const ty = enemy.position.y - (dy / dist) * 20;
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
            const bx = cx * t + rx * (1 - t);
            const by = cy * t + ry * (1 - t);
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

    // -----------------------------------------------------------------------
    // Helpers
    // -----------------------------------------------------------------------

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
