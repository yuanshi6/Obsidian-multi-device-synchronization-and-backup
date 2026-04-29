import {
	computeSyncDelta,
	FileScanner,
	normalizeSyncPath,
	FileState,
	DeletedEntry,
	SyncManifest,
	sha256Hex,
} from "../src/scanner";
import {S3BackupSettings} from "../src/settings";

const H1 = "a".repeat(64);
const H2 = "b".repeat(64);
const H3 = "c".repeat(64);

function fs(
	version: number,
	contentHash = H1,
	baseVersion = version,
	parentHash = contentHash,
	lastModifiedBy = "dev1",
	mtime = version,
): FileState {
	return {
		fileId: "file-id",
		version,
		baseVersion,
		contentHash,
		mtime,
		lastModifiedBy,
		parentHash,
	};
}

function dirty(baseVersion: number, contentHash = H2, parentHash = H1): FileState {
	return fs(baseVersion, contentHash, baseVersion, parentHash);
}

function tomb(version: number, baseVersion = Math.max(0, version - 1), deletedBy = "dev1"): DeletedEntry {
	return {
		mtime: version,
		deletedBy,
		version,
		baseVersion,
		fileId: "file-id",
		contentHash: H1,
		ackedBy: {[deletedBy]: version},
	};
}

function manifest(files: Record<string, FileState> = {}, deleted: Record<string, DeletedEntry> = {}): SyncManifest {
	return {version: "4.0", deviceId: "cloud", deviceName: "cloud", lastSyncTime: Date.now(), files, deleted};
}

const defaultSettings: S3BackupSettings = {
	accessKey: "", secretKey: "", endpoint: "", region: "",
	bucketName: "", autoSync: false, syncInterval: 30,
	excludePatterns: ".obsidian,.trash", deviceId: "dev1", deviceName: "test",
};

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

describe("computeSyncDelta", () => {
	describe("local-only files", () => {
		it("uploads new local file based on version 0", () => {
			const local = {"notes/a.md": fs(0, H1, 0, "")};
			const delta = computeSyncDelta(local, manifest());
			expect(delta.uploadQueue).toContain("notes/a.md");
			expect(delta.downloadQueue).toHaveLength(0);
		});

		it("skips already-versioned local file when cloud has no tombstone", () => {
			const local = {"notes/a.md": fs(1)};
			const delta = computeSyncDelta(local, manifest());
			expect(delta.uploadQueue).toHaveLength(0);
			expect(delta.downloadQueue).toHaveLength(0);
		});
	});

	describe("cloud-only files", () => {
		it("downloads cloud-only file", () => {
			const cloud = manifest({"notes/b.md": fs(2, H2)});
			const delta = computeSyncDelta({}, cloud);
			expect(delta.downloadQueue).toContain("notes/b.md");
			expect(delta.uploadQueue).toHaveLength(0);
		});
	});

	describe("version-chain decisions", () => {
		it("uploads dirty local content only when local.baseVersion equals cloud.version", () => {
			const local = {"notes/a.md": dirty(2, H2, H1)};
			const cloud = manifest({"notes/a.md": fs(2, H1)});
			const delta = computeSyncDelta(local, cloud);
			expect(delta.uploadQueue).toContain("notes/a.md");
			expect(delta.conflictQueue).toHaveLength(0);
		});

		it("conflicts when dirty local content is based on an older cloud version", () => {
			const local = {"notes/a.md": dirty(10, H2, H1)};
			const cloud = manifest({"notes/a.md": fs(11, H3)});
			const delta = computeSyncDelta(local, cloud);
			expect(delta.conflictQueue).toContain("notes/a.md");
			expect(delta.uploadQueue).toHaveLength(0);
			expect(delta.downloadQueue).toHaveLength(0);
		});

		it("downloads when local content is unchanged and cloud version is newer", () => {
			const local = {"notes/a.md": fs(10, H1, 10, H1, "dev1", 999999)};
			const cloud = manifest({"notes/a.md": fs(11, H2)});
			const delta = computeSyncDelta(local, cloud);
			expect(delta.downloadQueue).toContain("notes/a.md");
			expect(delta.uploadQueue).toHaveLength(0);
		});

		it("does not treat a newer local mtime as a reason to upload", () => {
			const local = {"notes/a.md": fs(10, H1, 10, H1, "dev1", 999999)};
			const cloud = manifest({"notes/a.md": fs(11, H2, 11, H2, "dev2", 1)});
			const delta = computeSyncDelta(local, cloud);
			expect(delta.downloadQueue).toContain("notes/a.md");
			expect(delta.uploadQueue).toHaveLength(0);
		});

		it("skips when local and cloud are already the same version and hash", () => {
			const local = {"notes/a.md": fs(2, H1)};
			const cloud = manifest({"notes/a.md": fs(2, H1)});
			const delta = computeSyncDelta(local, cloud);
			expect(delta.uploadQueue).toHaveLength(0);
			expect(delta.downloadQueue).toHaveLength(0);
			expect(delta.conflictQueue).toHaveLength(0);
		});

		it("hash stitches when no ledger entry and SHA-256 hashes match", () => {
			const local = {"notes/a.md": fs(0, H1, 0, "")};
			const cloud = manifest({"notes/a.md": fs(2, H1)});
			const delta = computeSyncDelta(local, cloud, "dev1", {}, {});
			expect(delta.hashStitched).toContain("notes/a.md");
			expect(delta.uploadQueue).toHaveLength(0);
			expect(delta.downloadQueue).toHaveLength(0);
		});

		it("does not hash stitch when ledger entry exists", () => {
			const local = {"notes/a.md": fs(2, H1)};
			const cloud = manifest({"notes/a.md": fs(2, H1)});
			const ledger = {"notes/a.md": fs(2, H1)};
			const delta = computeSyncDelta(local, cloud, "dev1", {}, ledger);
			expect(delta.hashStitched).toHaveLength(0);
		});
	});

	describe("tombstone logic", () => {
		it("local tomb + cloud tomb skips because both sides are deleted", () => {
			const localTombs = {"notes/a.md": tomb(3, 2)};
			const cloud = manifest({}, {"notes/a.md": tomb(3, 2, "dev2")});
			const delta = computeSyncDelta({}, cloud, "dev1", localTombs, {});
			expect(delta.uploadQueue).toHaveLength(0);
			expect(delta.downloadQueue).toHaveLength(0);
			expect(delta.deleteQueue).toHaveLength(0);
			expect(delta.localDeleteQueue).toHaveLength(0);
		});

		it("local tomb deletes cloud only when tombstone baseVersion equals cloud.version", () => {
			const localTombs = {"notes/a.md": tomb(3, 2)};
			const cloud = manifest({"notes/a.md": fs(2, H1)});
			const delta = computeSyncDelta({}, cloud, "dev1", localTombs, {});
			expect(delta.deleteQueue).toContain("notes/a.md");
			expect(delta.conflictQueue).toHaveLength(0);
		});

		it("local tomb conflicts when cloud has advanced", () => {
			const localTombs = {"notes/a.md": tomb(3, 2)};
			const cloud = manifest({"notes/a.md": fs(4, H2)});
			const delta = computeSyncDelta({}, cloud, "dev1", localTombs, {});
			expect(delta.conflictQueue).toContain("notes/a.md");
			expect(delta.deleteQueue).toHaveLength(0);
		});

		it("cloud tomb deletes unchanged local file", () => {
			const local = {"notes/a.md": fs(2, H1)};
			const cloud = manifest({}, {"notes/a.md": tomb(3, 2, "dev2")});
			const delta = computeSyncDelta(local, cloud, "dev1", {}, {});
			expect(delta.localDeleteQueue).toContain("notes/a.md");
			expect(delta.uploadQueue).toHaveLength(0);
		});

		it("cloud tomb conflicts with dirty local changes based on an older version", () => {
			const local = {"notes/a.md": dirty(2, H2, H1)};
			const cloud = manifest({}, {"notes/a.md": tomb(3, 2, "dev2")});
			const delta = computeSyncDelta(local, cloud, "dev1", {}, {});
			expect(delta.conflictQueue).toContain("notes/a.md");
			expect(delta.localDeleteQueue).toHaveLength(0);
		});

		it("cloud tomb + no local file skips", () => {
			const cloud = manifest({}, {"notes/a.md": tomb(3, 2)});
			const delta = computeSyncDelta({}, cloud, "dev1", {}, {});
			expect(delta.localDeleteQueue).toHaveLength(0);
			expect(delta.uploadQueue).toHaveLength(0);
		});
	});

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
			const local = {"notes/a.md": fs(0, H1, 0, "")};
			const delta = computeSyncDelta(local, null);
			expect(delta.uploadQueue).toContain("notes/a.md");
		});
	});

	describe("multiple files mixed", () => {
		it("correctly categorizes multiple files", () => {
			const local = {
				"a.md": fs(0, H1, 0, ""),
				"b.md": fs(2, H1),
				"c.md": dirty(2, H2, H1),
				"e.md": fs(0, H3, 0, ""),
			};
			const cloud = manifest({
				"c.md": fs(2, H1),
				"d.md": fs(4, H2),
				"e.md": fs(2, H3),
			});
			const delta = computeSyncDelta(local, cloud, "dev1", {}, {});
			expect(delta.uploadQueue).toContain("a.md");
			expect(delta.uploadQueue).toContain("c.md");
			expect(delta.downloadQueue).toContain("d.md");
			expect(delta.hashStitched).toContain("e.md");
			expect(delta.uploadQueue).not.toContain("b.md");
		});
	});
});

describe("FileScanner", () => {
	function mockAdapter(files: Record<string, {mtime: number; size: number; content: string}>, folders: string[] = []) {
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
			readBinary: jest.fn().mockImplementation((path: string) => {
				const f = files[path];
				return Promise.resolve(new TextEncoder().encode(f?.content ?? "").buffer);
			}),
		} as any;
	}

	it("scans files and returns SHA-256 FileState entries", async () => {
		const adapter = mockAdapter({
			"notes/a.md": {mtime: 1000, size: 50, content: "alpha"},
			"notes/b.md": {mtime: 2000, size: 100, content: "beta"},
		});
		const scanner = new FileScanner(adapter, defaultSettings);
		const result = await scanner.scanAll();

		expect(Object.keys(result)).toHaveLength(2);
		expect(result["notes/a.md"]).toEqual({
			fileId: "notes/a.md",
			version: 0,
			baseVersion: 0,
			contentHash: await sha256Hex(new TextEncoder().encode("alpha")),
			mtime: 1000,
			lastModifiedBy: "dev1",
			parentHash: "",
		});
		expect(result["notes/b.md"]?.contentHash).toBe(await sha256Hex(new TextEncoder().encode("beta")));
	});

	it("excludes files matching exclude patterns", async () => {
		const adapter = mockAdapter({
			".obsidian/config": {mtime: 1000, size: 10, content: "config"},
			".trash/deleted.md": {mtime: 2000, size: 20, content: "trash"},
			"notes/good.md": {mtime: 3000, size: 30, content: "good"},
		});
		const scanner = new FileScanner(adapter, defaultSettings);
		const result = await scanner.scanAll();

		expect(Object.keys(result)).toHaveLength(1);
		expect(result["notes/good.md"]).toBeDefined();
	});

	it("excludes system files (.DS_Store, Thumbs.db)", async () => {
		const adapter = mockAdapter({
			".DS_Store": {mtime: 1000, size: 6, content: "noise"},
			"Thumbs.db": {mtime: 2000, size: 8, content: "noise"},
			"notes/real.md": {mtime: 3000, size: 30, content: "real"},
		});
		const scanner = new FileScanner(adapter, defaultSettings);
		const result = await scanner.scanAll();

		expect(Object.keys(result)).toHaveLength(1);
		expect(result["notes/real.md"]).toBeDefined();
	});

	it("skips files with null mtime", async () => {
		const adapter = mockAdapter({
			"notes/ok.md": {mtime: 1000, size: 10, content: "ok"},
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
			"folder\\sub\\file.md": {mtime: 1000, size: 10, content: "file"},
		});
		adapter.list.mockResolvedValue({
			files: ["folder\\sub\\file.md"],
			folders: [],
		});
		const scanner = new FileScanner(adapter, defaultSettings);
		const result = await scanner.scanAll();

		expect(result["folder/sub/file.md"]).toBeDefined();
	});

	it("handles wildcard exclude patterns", async () => {
		const settings: S3BackupSettings = {
			...defaultSettings,
			excludePatterns: "*.tmp,*.bak",
		};
		const adapter = mockAdapter({
			"notes/a.tmp": {mtime: 1000, size: 10, content: "tmp"},
			"notes/b.bak": {mtime: 2000, size: 20, content: "bak"},
			"notes/c.md": {mtime: 3000, size: 30, content: "md"},
		});
		const scanner = new FileScanner(adapter, settings);
		const result = await scanner.scanAll();

		expect(Object.keys(result)).toHaveLength(1);
		expect(result["notes/c.md"]).toBeDefined();
	});
});
