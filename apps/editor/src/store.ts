import type { Dungeon, DungeonManifest, DraftIndexEntry, Floor } from "@dungeon/shared";

export const manifestKey = (id: string) => `dungeons/${id}/manifest.json`;
export const floorKey = (id: string, rev: number, n: number) => `dungeons/${id}/r${rev}/floor-${n}.json`;
export const INDEX_KEY = "index.json"; // draft bucket only
export const PUBLISHED_INDEX_KEY = "dungeon:index"; // KV, read by the game

export async function readJsonObject<T>(bucket: R2Bucket, key: string): Promise<T | null> {
	const obj = await bucket.get(key);
	return obj ? ((await obj.json()) as T) : null;
}

export const putJson = (bucket: R2Bucket, key: string, value: unknown) =>
	bucket.put(key, JSON.stringify(value), { httpMetadata: { contentType: "application/json" } });

export function toManifest(d: Dungeon, extra: Partial<DungeonManifest> = {}): DungeonManifest {
	return {
		id: d.id, name: d.name, revision: d.revision, startPoint: d.startPoint, updatedAt: d.updatedAt,
		floors: d.floors.map((f) => ({ index: f.index, width: f.width, height: f.height })),
		...extra,
	};
}

export async function loadDungeon(bucket: R2Bucket, id: string): Promise<Dungeon | null> {
	const m = await readJsonObject<DungeonManifest>(bucket, manifestKey(id));
	if (!m) return null;
	const floors = await Promise.all(m.floors.map((f) => readJsonObject<Floor>(bucket, floorKey(id, m.revision, f.index))));
	if (floors.some((f) => !f)) return null;
	return { id: m.id, name: m.name, revision: m.revision, startPoint: m.startPoint, updatedAt: m.updatedAt, floors: floors as Floor[] };
}

/** Delete every object under dungeons/{id}/ whose revision directory is not in `keep`. */
export async function deleteRevisionsExcept(bucket: R2Bucket, id: string, keep: ReadonlySet<number>, all = false): Promise<void> {
	const prefix = `dungeons/${id}/`;
	let cursor: string | undefined;
	do {
		const page = await bucket.list({ prefix, cursor });
		const doomed = page.objects
			.map((o) => o.key)
			.filter((k) => {
				if (k === manifestKey(id)) return all;
				const m = /\/r(\d+)\//.exec(k);
				return all || (m ? !keep.has(Number(m[1])) : false);
			});
		if (doomed.length) await bucket.delete(doomed);
		cursor = page.truncated ? page.cursor : undefined;
	} while (cursor);
}

export async function readDraftIndex(bucket: R2Bucket): Promise<DraftIndexEntry[]> {
	return (await readJsonObject<DraftIndexEntry[]>(bucket, INDEX_KEY)) ?? [];
}
