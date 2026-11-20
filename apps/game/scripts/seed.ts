// Generates a sample 3-floor dungeon with @dungeon/shared (same output shape the editor will publish).
import { generateFloor, linkStairs, validateDungeon, type Dungeon, type DungeonIndexEntry, type DungeonManifest } from "@dungeon/shared";

const FLOORS = 3;
const gens = Array.from({ length: FLOORS }, (_, i) =>
	generateFloor({ index: i, width: 10, height: 10, seed: 100 + i, upStairs: i > 0, downStairs: i < FLOORS - 1, chestRate: 0.05 }),
);
const floors = linkStairs(gens.map((g) => g.floor));
const dungeon: Dungeon = {
	id: "sample", name: "サンプルダンジョン", revision: 1, updatedAt: new Date().toISOString(),
	startPoint: { floor: 0, x: gens[0]!.start.x, y: gens[0]!.start.y, dir: 0 },
	floors,
};
const errors = validateDungeon(dungeon, { forPublish: true });
if (errors.length) throw new Error("sample dungeon invalid:\n" + errors.join("\n"));

const manifest: DungeonManifest = {
	id: dungeon.id, name: dungeon.name, revision: dungeon.revision, startPoint: dungeon.startPoint,
	updatedAt: dungeon.updatedAt, floors: floors.map((f) => ({ index: f.index, width: f.width, height: f.height })),
};
const index: DungeonIndexEntry[] = [{ id: dungeon.id, name: dungeon.name, revision: dungeon.revision, floors: FLOORS, publishedAt: dungeon.updatedAt }];

/** key -> JSON text */
export const files: Record<string, string> = {
	[`dungeons/${dungeon.id}/manifest.json`]: JSON.stringify(manifest),
	...Object.fromEntries(floors.map((f) => [`dungeons/${dungeon.id}/r${dungeon.revision}/floor-${f.index}.json`, JSON.stringify(f)])),
};
export const indexJson = JSON.stringify(index);
