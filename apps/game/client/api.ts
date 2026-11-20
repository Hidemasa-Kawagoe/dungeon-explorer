import type { DungeonIndexEntry, DungeonManifest, Floor, PlayerSave } from "@dungeon/shared";

async function get<T>(url: string): Promise<T> {
	const res = await fetch(url);
	if (!res.ok) throw new Error(`${url}: ${res.status}`);
	return (await res.json()) as T;
}

export const listDungeons = () => get<DungeonIndexEntry[]>("/api/dungeons");
export const getManifest = (id: string) => get<DungeonManifest>(`/api/dungeons/${id}`);
export const getFloor = (id: string, n: number, rev: number) =>
	get<Floor>(`/api/dungeons/${id}/floors/${n}?rev=${rev}`);
export const getSave = (id: string) => get<PlayerSave | null>(`/api/save/${id}`);

export type SaveBody = Pick<PlayerSave, "dungeonRevision" | "position" | "visited" | "openedChests" | "inventory">;

export async function putSave(id: string, body: SaveBody, keepalive = false): Promise<boolean> {
	try {
		const res = await fetch(`/api/save/${id}`, {
			method: "PUT",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(body),
			keepalive,
		});
		return res.ok;
	} catch {
		return false; // offline etc.: the next save will retry with the full state
	}
}
