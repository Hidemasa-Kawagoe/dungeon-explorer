import { DurableObject } from "cloudflare:workers";
import {
	validateDungeon, type Dungeon, type DungeonIndexEntry, type DungeonManifest, type DraftIndexEntry,
} from "@dungeon/shared";
import {
	INDEX_KEY, PUBLISHED_INDEX_KEY, deleteRevisionsExcept, floorKey, loadDungeon, manifestKey, putJson,
	readDraftIndex, readJsonObject, toManifest,
} from "../store";

export type Result<T = object> = ({ ok: true } & T) | { ok: false; status: number; error: string; errors?: string[]; revision?: number };

const KEEP_DRAFT_REVISIONS = 3;

/**
 * One instance per dungeon id serialises that dungeon's writes (revision check -> R2 -> index).
 * The instance named "__index__" owns the shared indexes, so concurrent writes for different
 * dungeons can't clobber each other's read-modify-write of index.json / dungeon:index.
 *
 * R2 is the source of truth (strongly consistent); the DO provides mutual exclusion because
 * requests may interleave at every `await`.
 */
export class DungeonEditorLock extends DurableObject<Env> {
	private chain: Promise<unknown> = Promise.resolve();

	private exclusive<T>(fn: () => Promise<T>): Promise<T> {
		const run = this.chain.then(fn, fn);
		this.chain = run.catch(() => undefined);
		return run;
	}

	private indexStub() {
		return this.env.EDITOR_LOCK.get(this.env.EDITOR_LOCK.idFromName("__index__")) as unknown as DurableObjectStub<DungeonEditorLock>;
	}

	// ---- per-dungeon operations -------------------------------------------
	create(email: string, d: Dungeon): Promise<Result<{ revision: number }>> {
		return this.exclusive(async () => {
			if (await this.env.DRAFT.head(manifestKey(d.id))) return { ok: false, status: 409, error: "already exists" };
			return this.writeDraft(email, d, 1);
		});
	}

	save(email: string, d: Dungeon, ifMatch: number): Promise<Result<{ revision: number }>> {
		return this.exclusive(async () => {
			const cur = await readJsonObject<DungeonManifest>(this.env.DRAFT, manifestKey(d.id));
			if (!cur) return { ok: false, status: 404, error: "dungeon not found" };
			if (cur.revision !== ifMatch) {
				return { ok: false, status: 409, error: "revision conflict: reload the latest version", revision: cur.revision };
			}
			return this.writeDraft(email, d, cur.revision + 1);
		});
	}

	private async writeDraft(email: string, d: Dungeon, revision: number): Promise<Result<{ revision: number }>> {
		const saved: Dungeon = { ...d, revision, updatedAt: new Date().toISOString() };
		// New revision's floors first, manifest last: until the manifest flips, the old version stays intact.
		await Promise.all(saved.floors.map((f) => putJson(this.env.DRAFT, floorKey(saved.id, revision, f.index), f)));
		await putJson(this.env.DRAFT, manifestKey(saved.id), toManifest(saved, { updatedBy: email }));
		await this.indexStub().upsertDraft({
			id: saved.id, name: saved.name, revision, floors: saved.floors.length,
			updatedAt: saved.updatedAt, updatedBy: email,
		});
		const keep = new Set<number>();
		for (let r = revision; r > revision - KEEP_DRAFT_REVISIONS; r--) keep.add(r);
		await deleteRevisionsExcept(this.env.DRAFT, saved.id, keep);
		return { ok: true, revision };
	}

	publish(email: string, id: string): Promise<Result<{ revision: number }>> {
		return this.exclusive(async () => {
			const d = await loadDungeon(this.env.DRAFT, id);
			if (!d) return { ok: false, status: 404, error: "dungeon not found" };
			const errors = validateDungeon(d, { forPublish: true });
			if (errors.length) return { ok: false, status: 422, error: "dungeon is not publishable", errors };

			const prev = await readJsonObject<DungeonManifest>(this.env.PUBLISHED, manifestKey(id));
			await Promise.all(d.floors.map((f) => putJson(this.env.PUBLISHED, floorKey(id, d.revision, f.index), f)));
			await putJson(this.env.PUBLISHED, manifestKey(id), toManifest(d, { publishedBy: email }));
			const entry: DungeonIndexEntry = {
				id, name: d.name, revision: d.revision, floors: d.floors.length, publishedAt: new Date().toISOString(),
			};
			await this.indexStub().setPublished(id, entry);
			if (prev && prev.revision !== d.revision) await deleteRevisionsExcept(this.env.PUBLISHED, id, new Set([d.revision]));
			return { ok: true, revision: d.revision };
		});
	}

	unpublish(id: string): Promise<Result> {
		return this.exclusive(async () => {
			if (!(await this.env.DRAFT.head(manifestKey(id)))) return { ok: false, status: 404, error: "dungeon not found" };
			// Remove from the public list first so the game stops offering it, then drop the data.
			await this.indexStub().setPublished(id, null);
			await deleteRevisionsExcept(this.env.PUBLISHED, id, new Set(), true);
			return { ok: true };
		});
	}

	remove(id: string): Promise<Result> {
		return this.exclusive(async () => {
			if (!(await this.env.DRAFT.head(manifestKey(id)))) return { ok: false, status: 404, error: "dungeon not found" };
			await this.indexStub().setPublished(id, null);
			await deleteRevisionsExcept(this.env.PUBLISHED, id, new Set(), true);
			await deleteRevisionsExcept(this.env.DRAFT, id, new Set(), true);
			await this.indexStub().removeDraft(id);
			return { ok: true };
		});
	}

	// ---- index instance ("__index__") --------------------------------------
	upsertDraft(entry: Omit<DraftIndexEntry, "publishedRevision">): Promise<void> {
		return this.exclusive(async () => {
			const list = await readDraftIndex(this.env.DRAFT);
			const old = list.find((e) => e.id === entry.id);
			const next: DraftIndexEntry = { ...entry, publishedRevision: old?.publishedRevision ?? null };
			await this.writeDraftIndex(old ? list.map((e) => (e.id === entry.id ? next : e)) : [...list, next]);
		});
	}

	removeDraft(id: string): Promise<void> {
		return this.exclusive(async () => {
			await this.writeDraftIndex((await readDraftIndex(this.env.DRAFT)).filter((e) => e.id !== id));
		});
	}

	/** entry=null unpublishes. Updates the public KV list and the draft index's publishedRevision. */
	setPublished(id: string, entry: DungeonIndexEntry | null): Promise<void> {
		return this.exclusive(async () => {
			const pub = (await this.env.DUNGEON_META.get<DungeonIndexEntry[]>(PUBLISHED_INDEX_KEY, "json")) ?? [];
			const rest = pub.filter((e) => e.id !== id);
			await this.env.DUNGEON_META.put(PUBLISHED_INDEX_KEY, JSON.stringify(entry ? [...rest, entry] : rest));
			const list = await readDraftIndex(this.env.DRAFT);
			await this.writeDraftIndex(list.map((e) => (e.id === id ? { ...e, publishedRevision: entry?.revision ?? null } : e)));
		});
	}

	private writeDraftIndex(list: DraftIndexEntry[]) {
		return putJson(this.env.DRAFT, INDEX_KEY, list);
	}
}
