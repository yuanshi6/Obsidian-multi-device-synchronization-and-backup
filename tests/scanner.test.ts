import {
	computeSyncDelta,
	FileScanner,
	normalizeSyncPath,
	FileState,
	DeletedEntry,
	SyncManifest,
} from "../src/scanner";
import {S3BackupSettings} from "../src/settings";

// ── Helpers ──

function fs(lastPenDropTime: number, isUploaded = false, hash = "", lastModifiedBy = "dev1"): FileState {
	return {lastPenDropTime, isUploaded, hash, lastModifiedBy};
}

function tomb(mtime: number, deletedBy = "dev1"): DeletedEntry {
	return {mtime, deletedBy};
}

function manifest(files: Record<string, FileState> = {}, deleted: Record<string, DeletedEntry> = {}): SyncManifest {
	return {version: "3.0", deviceId: "cloud", deviceName: "cloud", lastSyncTime: Date.now(), files, deleted};
}

const defaultSettings: S3BackupSettings = {
	accessKey: "", secretKey: "", endpoint: "", region: "",
	bucketName: "", autoSync: false, syncInterval: 30,
	excludePatterns: ".obsidian,.trash", deviceId: "dev1", deviceName: "test",
};

// ══════════════════════════════════════════════════════════
// normalizeSyncPath
// ══════════════════════════════════════════════════════════

describe("normalizeSyncPath", () => {
	it("converts backslashes to forward slashes", () => {
		expect(normalizeSyncPath("folder\\sub\\file.md")).toBe("folder/sub/file.md");
	});

	it("leaves forward slashes unchanged", () => {
		expect(normalizeSyncPath("folder/sub/file.md")).toBe("folder/sub/file.md");
	});

	it("handles mixed slashes", () => {
		expect(normalizeSyncPath("folder\\sub/file.md")).toBe("folder/sub/file.md");
	});

	it("handles no slashes", () => {
		expect(normalizeSyncPath("file.md")).toBe("file.md");
	});
});

// ══════════════════════════════════════════════════════════
// computeSyncDelta — 核心同步 Diff 算法
// ══════════════════════════════════════════════════════════

describe("computeSyncDelta", () => {
	// ── 场景 1：仅本地存在 ──

	describe("local-only files", () => {
		it("uploads new local file (isUploaded=false)", () => {
			const local = {"notes/a.md": fs(100, false)};
			const delta = computeSyncDelta(local, manifest());
			expect(delta.uploadQueue).toContain("notes/a.md");
			expect(delta.downloadQueue).toHaveLength(0);
		});

		it("skips already-uploaded local file (isUploaded=true)", () => {
			const local = {"notes/a.md": fs(100, true)};
			const delta = computeSyncDelta(local, manifest());
			expect(delta.uploadQueue).toHaveLength(0);
			expect(delta.downloadQueue).toHaveLength(0);
		});
	});

	// ── 场景 2：仅云端存在 ──

	describe("cloud-only files", () => {
		it("downloads cloud-only file", () => {
			const cloud = manifest({"notes/b.md": fs(200, true)});
			const delta = computeSyncDelta({}, cloud);
			expect(delta.downloadQueue).toContain("notes/b.md");
			expect(delta.uploadQueue).toHaveLength(0);
		});
	});

	// ── 场景 3：本地和云端都有 ──

	describe("both local and cloud", () => {
		it("uploads when local is newer (lastPenDropTime > cloud)", () => {
			const local = {"notes/a.md": fs(300, false)};
			const cloud = manifest({"notes/a.md": fs(200, true)});
			const delta = computeSyncDelta(local, cloud);
			expect(delta.uploadQueue).toContain("notes/a.md");
			expect(delta.downloadQueue).toHaveLength(0);
		});

		it("downloads when cloud is newer (lastPenDropTime > local)", () => {
			const local = {"notes/a.md": fs(100, true)};
			const cloud = manifest({"notes/a.md": fs(200, true)});
			const delta = computeSyncDelta(local, cloud);
			expect(delta.downloadQueue).toContain("notes/a.md");
			expect(delta.uploadQueue).toHaveLength(0);
		});

		it("uploads when timestamps equal but isUploaded=false", () => {
			const local = {"notes/a.md": fs(200, false)};
			const cloud = manifest({"notes/a.md": fs(200, true)});
			const delta = computeSyncDelta(local, cloud);
			expect(delta.uploadQueue).toContain("notes/a.md");
		});

		it("skips when timestamps equal and isUploaded=true", () => {
			const local = {"notes/a.md": fs(200, true)};
			const cloud = manifest({"notes/a.md": fs(200, true)});
			const delta = computeSyncDelta(local, cloud);
			expect(delta.uploadQueue).toHaveLength(0);
			expect(delta.downloadQueue).toHaveLength(0);
		});

		it("hash stitches when no ledger entry and hashes match", () => {
			const local = {"notes/a.md": fs(100, false, "abc123")};
			const cloud = manifest({"notes/a.md": fs(200, true, "abc123")});
			const delta = computeSyncDelta(local, cloud, "dev1", {}, {});
			expect(delta.hashStitched).toContain("notes/a.md");
			expect(delta.uploadQueue).toHaveLength(0);
			expect(delta.downloadQueue).toHaveLength(0);
		});

		it("does not hash stitch when ledger entry exists", () => {
			const local = {"notes/a.md": fs(100, false, "abc123")};
			const cloud = manifest({"notes/a.md": fs(200, true, "abc123")});
			const ledger = {"notes/a.md": fs(100, false, "abc123")};
			const delta = computeSyncDelta(local, cloud, "dev1", {}, ledger);
			expect(delta.hashStitched).toHaveLength(0);
		});

		it("does not hash stitch when hashes differ", () => {
			const local = {"notes/a.md": fs(100, false, "hash1")};
			const cloud = manifest({"notes/a.md": fs(200, true, "hash2")});
			const delta = computeSyncDelta(local, cloud, "dev1", {}, {});
			expect(delta.hashStitched).toHaveLength(0);
			// cloud is newer → download
			expect(delta.downloadQueue).toContain("notes/a.md");
		});
	});

	// ── 场景 4：墓碑逻辑 ──

	describe("tombstone logic", () => {
		it("local tomb + cloud tomb → skip (both deleted)", () => {
			const local = {"notes/a.md": fs(100, true)};
			const localTombs = {"notes/a.md": tomb(150)};
			const cloud = manifest({"notes/a.md": fs(100, true)}, {"notes/a.md": tomb(160)});
			const delta = computeSyncDelta(local, cloud, "dev1", localTombs, {});
			expect(delta.uploadQueue).toHaveLength(0);
			expect(delta.downloadQueue).toHaveLength(0);
			expect(delta.deleteQueue).toHaveLength(0);
			expect(delta.localDeleteQueue).toHaveLength(0);
		});

		it("local tomb + no cloud tomb + cloud exists → delete cloud if tomb >= cloud time", () => {
			const localTombs = {"notes/a.md": tomb(300)};
			const cloud = manifest({"notes/a.md": fs(200, true)});
			const delta = computeSyncDelta({}, cloud, "dev1", localTombs, {});
			expect(delta.deleteQueue).toContain("notes/a.md");
			expect(delta.downloadQueue).toHaveLength(0);
		});

		it("local tomb + no cloud tomb + cloud exists → download if cloud is newer", () => {
			const localTombs = {"notes/a.md": tomb(100)};
			const cloud = manifest({"notes/a.md": fs(200, true)});
			const delta = computeSyncDelta({}, cloud, "dev1", localTombs, {});
			expect(delta.downloadQueue).toContain("notes/a.md");
			expect(delta.deleteQueue).toHaveLength(0);
		});

		it("cloud tomb + local exists → delete local if tomb >= local time", () => {
			const local = {"notes/a.md": fs(100, true)};
			const cloud = manifest({}, {"notes/a.md": tomb(200)});
			const delta = computeSyncDelta(local, cloud, "dev1", {}, {});
			expect(delta.localDeleteQueue).toContain("notes/a.md");
			expect(delta.uploadQueue).toHaveLength(0);
		});

		it("cloud tomb + local exists → upload if local is newer", () => {
			const local = {"notes/a.md": fs(300, false)};
			const cloud = manifest({}, {"notes/a.md": tomb(200)});
			const delta = computeSyncDelta(local, cloud, "dev1", {}, {});
			expect(delta.uploadQueue).toContain("notes/a.md");
			expect(delta.localDeleteQueue).toHaveLength(0);
		});

		it("cloud tomb + no local file → skip", () => {
			const cloud = manifest({}, {"notes/a.md": tomb(200)});
			const delta = computeSyncDelta({}, cloud, "dev1", {}, {});
			expect(delta.localDeleteQueue).toHaveLength(0);
			expect(delta.uploadQueue).toHaveLength(0);
		});

		it("local tomb + no cloud tomb + no cloud file → skip", () => {
			const localTombs = {"notes/a.md": tomb(100)};
			const delta = computeSyncDelta({}, manifest(), "dev1", localTombs, {});
			expect(delta.deleteQueue).toHaveLength(0);
			expect(delta.downloadQueue).toHaveLength(0);
		});
	});

	// ── 场景 5：空输入 ──

	describe("empty inputs", () => {
		it("returns empty delta when both local and cloud are empty", () => {
			const delta = computeSyncDelta({}, manifest());
			expect(delta.uploadQueue).toHaveLength(0);
			expect(delta.downloadQueue).toHaveLength(0);
			expect(delta.deleteQueue).toHaveLength(0);
			expect(delta.localDeleteQueue).toHaveLength(0);
			expect(delta.conflictQueue).toHaveLength(0);
			expect(delta.hashStitched).toHaveLength(0);
		});

		it("handles null cloud manifest", () => {
			const local = {"notes/a.md": fs(100, false)};
			const delta = computeSyncDelta(local, null);
			expect(delta.uploadQueue).toContain("notes/a.md");
		});
	});

	// ── 场景 6：多文件混合 ──

	describe("multiple files mixed", () => {
		it("correctly categorizes multiple files", () => {
			const local = {
				"a.md": fs(100, false),        // local-only, not uploaded → upload
				"b.md": fs(200, true),         // local-only, uploaded → skip
				"c.md": fs(300, false),        // both, local newer → upload
				"e.md": fs(100, true, "h1"),   // both, same hash, no ledger → stitch
			};
			const cloud = manifest({
				"c.md": fs(200, true),
				"d.md": fs(400, true),          // cloud-only → download
				"e.md": fs(200, true, "h1"),
			});
			const delta = computeSyncDelta(local, cloud, "dev1", {}, {});
			expect(delta.uploadQueue).toContain("a.md");
			expect(delta.uploadQueue).toContain("c.md");
			expect(delta.downloadQueue).toContain("d.md");
			expect(delta.hashStitched).toContain("e.md");
			// b.md should be skipped entirely
			expect(delta.uploadQueue).not.toContain("b.md");
		});
	});
});

// ══════════════════════════════════════════════════════════
// FileScanner
// ══════════════════════════════════════════════════════════

describe("FileScanner", () => {
	function mockAdapter(files: Record<string, {mtime: number; size: number}>, folders: string[] = []) {
		const fileList = Object.keys(files);
		return {
			list: jest.fn().mockImplementation((dir: string) => {
				if (dir === "") {
					return {files: fileList, folders};
				}
				return {files: [], folders: []};
			}),
			stat: jest.fn().mockImplementation((path: string) => {
				const f = files[path];
				if (!f) return null;
				return {mtime: f.mtime, size: f.size};
			}),
		} as any;
	}

	it("scans files and returns FileState entries", async () => {
		const adapter = mockAdapter({
			"notes/a.md": {mtime: 1000, size: 50},
			"notes/b.md": {mtime: 2000, size: 100},
		});
		const scanner = new FileScanner(adapter, defaultSettings);
		const result = await scanner.scanAll();

		expect(Object.keys(result)).toHaveLength(2);
		expect(result["notes/a.md"]).toEqual({
			lastPenDropTime: 1000,
			isUploaded: false,
			hash: "50-1000",
			lastModifiedBy: "dev1",
		});
		expect(result["notes/b.md"]).toEqual({
			lastPenDropTime: 2000,
			isUploaded: false,
			hash: "100-2000",
			lastModifiedBy: "dev1",
		});
	});

	it("excludes files matching exclude patterns", async () => {
		const adapter = mockAdapter({
			".obsidian/config": {mtime: 1000, size: 10},
			".trash/deleted.md": {mtime: 2000, size: 20},
			"notes/good.md": {mtime: 3000, size: 30},
		});
		const scanner = new FileScanner(adapter, defaultSettings);
		const result = await scanner.scanAll();

		expect(Object.keys(result)).toHaveLength(1);
		expect(result["notes/good.md"]).toBeDefined();
	});

	it("excludes system files (.DS_Store, Thumbs.db)", async () => {
		const adapter = mockAdapter({
			".DS_Store": {mtime: 1000, size: 6},
			"Thumbs.db": {mtime: 2000, size: 8},
			"notes/real.md": {mtime: 3000, size: 30},
		});
		const scanner = new FileScanner(adapter, defaultSettings);
		const result = await scanner.scanAll();

		expect(Object.keys(result)).toHaveLength(1);
		expect(result["notes/real.md"]).toBeDefined();
	});

	it("skips files with null mtime", async () => {
		const adapter = mockAdapter({
			"notes/ok.md": {mtime: 1000, size: 10},
		});
		adapter.stat.mockImplementation((path: string) => {
			if (path === "notes/ok.md") return {mtime: 1000, size: 10};
			return {mtime: null, size: 10};
		});
		adapter.list.mockResolvedValue({
			files: ["notes/ok.md", "notes/bad.md"],
			folders: [],
		});
		const scanner = new FileScanner(adapter, defaultSettings);
		const result = await scanner.scanAll();

		expect(Object.keys(result)).toHaveLength(1);
		expect(result["notes/ok.md"]).toBeDefined();
	});

	it("returns empty result for empty vault", async () => {
		const adapter = mockAdapter({});
		const scanner = new FileScanner(adapter, defaultSettings);
		const result = await scanner.scanAll();
		expect(Object.keys(result)).toHaveLength(0);
	});

	it("normalizes paths with backslashes", async () => {
		const adapter = mockAdapter({
			"folder\\sub\\file.md": {mtime: 1000, size: 10},
		});
		adapter.list.mockResolvedValue({
			files: ["folder\\sub\\file.md"],
			folders: [],
		});
		const scanner = new FileScanner(adapter, defaultSettings);
		const result = await scanner.scanAll();

		// The scanner normalizes the path
		expect(result["folder/sub/file.md"]).toBeDefined();
	});

	it("handles wildcard exclude patterns", async () => {
		const settings: S3BackupSettings = {
			...defaultSettings,
			excludePatterns: "*.tmp,*.bak",
		};
		const adapter = mockAdapter({
			"notes/a.tmp": {mtime: 1000, size: 10},
			"notes/b.bak": {mtime: 2000, size: 20},
			"notes/c.md": {mtime: 3000, size: 30},
		});
		const scanner = new FileScanner(adapter, settings);
		const result = await scanner.scanAll();

		expect(Object.keys(result)).toHaveLength(1);
		expect(result["notes/c.md"]).toBeDefined();
	});
});
