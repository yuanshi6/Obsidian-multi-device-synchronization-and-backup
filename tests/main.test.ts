import S3SyncPlugin from "../src/main";
import {DeletedEntry, FileState, sha256Hex} from "../src/scanner";
import {TFile} from "obsidian";
import {ConflictModal} from "../src/ConflictModal";
import {S3TransferManager} from "../src/transfer";

// ── Mock obsidian ──

jest.mock("obsidian", () => {
	const TFileMock = class {
		path: string;
		constructor(path: string) { this.path = path; }
	};
	const TAbstractFileMock = class {
		path: string;
		constructor(path: string) { this.path = path; }
	};
	return {
		Platform: {
			isDesktop: true,
			isMobile: false,
			isDesktopApp: true,
			isMobileApp: false,
			isLinux: false,
			isMacOS: false,
			isWindows: false,
			isAndroid: false,
			isIos: false,
		},
		Plugin: class {
			app: any = {
				vault: {adapter: null, on: jest.fn()},
				loadLocalStorage: jest.fn(),
				saveLocalStorage: jest.fn(),
				addStatusBarItem: jest.fn(),
				addRibbonIcon: jest.fn(),
				addCommand: jest.fn(),
				addSettingTab: jest.fn(),
			};
			settings: any = {};
			async loadData() { return {}; }
			async saveData(_data: any) {}
			registerEvent() {}
			registerDomEvent() {}
			registerInterval() {}
		},
		PluginSettingTab: class {
			containerEl: any = {empty: jest.fn(), createEl: jest.fn()};
			constructor(_app: any, _plugin: any) {}
		},
		Notice: jest.fn(),
		TFile: TFileMock,
		TAbstractFile: TAbstractFileMock,
		Setting: class {
			constructor(_containerEl: any) {}
			setName(_n: string) { return this; }
			setDesc(_d: string) { return this; }
			addText(_cb: any) { return this; }
			addTextArea(_cb: any) { return this; }
			addToggle(_cb: any) { return this; }
			addButton(_cb: any) { return this; }
			addExtraButton(_cb: any) { return this; }
		},
		App: class {},
		Modal: class {
			app: any;
			contentEl: any = {empty: jest.fn(), createEl: jest.fn(), createDiv: jest.fn()};
			constructor(_app: any) {}
			onOpen() {}
			onClose() {}
			close() {}
			open() {}
		},
	};
});

// ── Helpers ──

const H1 = "a".repeat(64);
const H2 = "b".repeat(64);

function fs(version: number, contentHash = H1, baseVersion = version, parentHash = contentHash, lastModifiedBy = "dev1", mtime = version): FileState {
	return {fileId: "file-id", version, baseVersion, contentHash, mtime, lastModifiedBy, parentHash};
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

// ══════════════════════════════════════════════════════════
// Tombstone GC
// ══════════════════════════════════════════════════════════

describe("S3SyncPlugin — Tombstone GC", () => {
	it("keeps tombstones older than 30 days", () => {
		const plugin = new (S3SyncPlugin as any)();
		plugin.settings = {deviceId: "dev1"};
		const thirtyOneDaysAgo = Date.now() - 31 * 24 * 60 * 60 * 1000;
		const oneDayAgo = Date.now() - 1 * 24 * 60 * 60 * 1000;

		const tombstones = {
			"old.md": {...tomb(2, 1), mtime: thirtyOneDaysAgo},
			"recent.md": {...tomb(3, 2), mtime: oneDayAgo},
		};

		const result = plugin.runTombstoneGC(tombstones);
		expect(result["old.md"]).toBeDefined();
		expect(result["recent.md"]).toBeDefined();
	});

	it("returns empty for empty input", () => {
		const plugin = new (S3SyncPlugin as any)();
		plugin.settings = {deviceId: "dev1"};
		const result = plugin.runTombstoneGC({});
		expect(Object.keys(result)).toHaveLength(0);
	});

	it("keeps boundary tombstones exactly 30 days old", () => {
		const plugin = new (S3SyncPlugin as any)();
		plugin.settings = {deviceId: "dev1"};
		const thirtyDaysAgo = Date.now() - 30 * 24 * 60 * 60 * 1000;

		const result = plugin.runTombstoneGC({
			"boundary.md": {...tomb(3, 2), mtime: thirtyDaysAgo},
		});
		expect(result["boundary.md"]).toBeDefined();
	});
});

// ══════════════════════════════════════════════════════════
// Rename interceptor logic
// ══════════════════════════════════════════════════════════

describe("Rename interceptor logic", () => {
	it("transfers ledger entry from old path to new path and creates old-path tombstone", () => {
		const plugin = new (S3SyncPlugin as any)();
		plugin.settings = {deviceId: "dev1", excludePatterns: ""};
		plugin.localLedger = {
			"old/path.md": fs(10, H1),
		};
		plugin.localTombstones = {};

		const mockFile = new TFile("new/path.md");
		plugin.onFileRename(mockFile, "old/path.md");

		expect(plugin.localLedger["new/path.md"]).toBeDefined();
		expect(plugin.localLedger["new/path.md"].version).toBe(10);
		expect(plugin.localLedger["new/path.md"].parentHash).toBe("");
		expect(plugin.localLedger["old/path.md"]).toBeUndefined();
		expect(plugin.localTombstones["old/path.md"]).toBeDefined();
		expect(plugin.localTombstones["old/path.md"].baseVersion).toBe(10);
	});

	it("creates new ledger entry when old path has no record", () => {
		const plugin = new (S3SyncPlugin as any)();
		plugin.settings = {deviceId: "dev1", excludePatterns: ""};
		plugin.localLedger = {};
		plugin.localTombstones = {};

		const mockFile = new TFile("new/path.md");
		plugin.onFileRename(mockFile, "old/path.md");

		expect(plugin.localLedger["new/path.md"]).toBeDefined();
		expect(plugin.localLedger["new/path.md"].baseVersion).toBe(0);
	});

	it("treats moves from a sync target into a non-sync target as a source deletion", () => {
		const plugin = new (S3SyncPlugin as any)();
		plugin.settings = {deviceId: "dev1", excludePatterns: "", storagePrefix: "_obsidian-sync/"};
		plugin.localLedger = {};
		plugin.localTombstones = {};

		const mockFile = new TFile("_obsidian-sync/internal.md");
		plugin.onFileRename(mockFile, "old/path.md");

		expect(plugin.localLedger["_obsidian-sync/internal.md"]).toBeUndefined();
		expect(plugin.localTombstones["old/path.md"]).toBeDefined();
	});
});

// ══════════════════════════════════════════════════════════
// Delete interceptor logic — 所有同步目标文件类型都立碑
// ══════════════════════════════════════════════════════════

describe("Delete interceptor logic", () => {
	it("creates versioned tombstone for .md file deletion", () => {
		const plugin = new (S3SyncPlugin as any)();
		plugin.settings = {deviceId: "dev1", excludePatterns: ""};
		plugin.localLedger = {
			"notes/a.md": fs(10, H1),
		};
		plugin.localTombstones = {};
		plugin.isSyncing = false;

		const mockFile = new TFile("notes/a.md");
		plugin.onFileDelete(mockFile);

		expect(plugin.localTombstones["notes/a.md"]).toBeDefined();
		expect(plugin.localTombstones["notes/a.md"].baseVersion).toBe(10);
		expect(plugin.localTombstones["notes/a.md"].version).toBe(11);
		expect(plugin.localLedger["notes/a.md"]).toBeUndefined();
	});

	it("creates tombstone for .canvas file deletion", () => {
		const plugin = new (S3SyncPlugin as any)();
		plugin.settings = {deviceId: "dev1", excludePatterns: ""};
		plugin.localLedger = {
			"未命名.canvas": fs(3, H1),
		};
		plugin.localTombstones = {};
		plugin.isSyncing = false;

		const mockFile = new TFile("未命名.canvas");
		plugin.onFileDelete(mockFile);

		expect(plugin.localTombstones["未命名.canvas"]).toBeDefined();
		expect(plugin.localTombstones["未命名.canvas"].baseVersion).toBe(3);
		expect(plugin.localLedger["未命名.canvas"]).toBeUndefined();
	});

	it("creates tombstone for synced attachment deletion", () => {
		const plugin = new (S3SyncPlugin as any)();
		plugin.settings = {deviceId: "dev1", excludePatterns: ""};
		plugin.localLedger = {
			"images/photo.png": fs(2, H1),
		};
		plugin.localTombstones = {};
		plugin.isSyncing = false;

		const mockFile = new TFile("images/photo.png");
		plugin.onFileDelete(mockFile);

		expect(plugin.localTombstones["images/photo.png"]).toBeDefined();
		expect(plugin.localTombstones["images/photo.png"].baseVersion).toBe(2);
		expect(plugin.localLedger["images/photo.png"]).toBeUndefined();
	});

	it("does not create tombstone for excluded paths", () => {
		const plugin = new (S3SyncPlugin as any)();
		plugin.settings = {deviceId: "dev1", excludePatterns: ".trash,.obsidian"};
		plugin.localLedger = {
			".trash/deleted.canvas": fs(2, H1),
		};
		plugin.localTombstones = {};

		const mockFile = new TFile(".trash/deleted.canvas");
		plugin.onFileDelete(mockFile);

		expect(plugin.localTombstones[".trash/deleted.canvas"]).toBeUndefined();
	});

	it("does not create tombstone for system files", () => {
		const plugin = new (S3SyncPlugin as any)();
		plugin.settings = {deviceId: "dev1", excludePatterns: ""};
		plugin.localTombstones = {};

		const mockFile = new TFile(".DS_Store");
		plugin.onFileDelete(mockFile);

		expect(plugin.localTombstones[".DS_Store"]).toBeUndefined();
	});

	it("creates tombstone with baseVersion=0 when no ledger entry exists", () => {
		const plugin = new (S3SyncPlugin as any)();
		plugin.settings = {deviceId: "dev1", excludePatterns: ""};
		plugin.localLedger = {};
		plugin.localTombstones = {};

		const mockFile = new TFile("notes/orphan.canvas");
		plugin.onFileDelete(mockFile);

		expect(plugin.localTombstones["notes/orphan.canvas"]).toBeDefined();
		expect(plugin.localTombstones["notes/orphan.canvas"].baseVersion).toBe(0);
	});
});

describe("Startup external delete detection", () => {
	it("creates a tombstone and removes the ledger entry when a tracked file is missing on disk", async () => {
		const plugin = new (S3SyncPlugin as any)();
		plugin.settings = {
			deviceId: "dev1",
			excludePatterns: "",
			storagePrefix: "_obsidian-sync/",
		};
		plugin.localLedger = {
			"notes/deleted.md": fs(7, H1),
		};
		plugin.localTombstones = {};
		plugin.app.vault.adapter = {
			list: jest.fn().mockResolvedValue({files: [], folders: []}),
		};

		await plugin.detectExternalModifications();

		expect(plugin.localLedger["notes/deleted.md"]).toBeUndefined();
		expect(plugin.localTombstones["notes/deleted.md"]).toBeDefined();
		expect(plugin.localTombstones["notes/deleted.md"].baseVersion).toBe(7);
		expect(plugin.app.saveLocalStorage).toHaveBeenCalledWith(
			"s3-sync-tombstones",
			expect.stringContaining("notes/deleted.md"),
		);
	});
});

// ══════════════════════════════════════════════════════════
// Modify interceptor logic
// ══════════════════════════════════════════════════════════

describe("Modify interceptor logic", () => {
	it("records modification while preserving the last known base version", () => {
		const plugin = new (S3SyncPlugin as any)();
		plugin.settings = {deviceId: "dev1", excludePatterns: ".obsidian,.trash"};
		plugin.localLedger = {
			"notes/a.md": fs(10, H1),
		};
		plugin.localTombstones = {};

		const mockFile = new TFile("notes/a.md");
		plugin.onFileModify(mockFile);

		expect(plugin.localLedger["notes/a.md"]).toBeDefined();
		expect(plugin.localLedger["notes/a.md"].baseVersion).toBe(10);
		expect(plugin.localLedger["notes/a.md"].parentHash).toBe(H1);
		expect(plugin.localLedger["notes/a.md"].lastModifiedBy).toBe("dev1");
	});

	it("clears a local tombstone when the user recreates a file", () => {
		const plugin = new (S3SyncPlugin as any)();
		plugin.settings = {deviceId: "dev1", excludePatterns: ".obsidian,.trash"};
		plugin.localLedger = {};
		plugin.localTombstones = {"notes/a.md": tomb(11, 10)};

		const mockFile = new TFile("notes/a.md");
		plugin.onFileModify(mockFile);

		expect(plugin.localLedger["notes/a.md"].baseVersion).toBe(11);
		expect(plugin.localTombstones["notes/a.md"]).toBeUndefined();
	});
});

// ══════════════════════════════════════════════════════════
// Path-level suppression: observer ignores only sync-engine writes
// ══════════════════════════════════════════════════════════

describe("Path-level suppression", () => {
	it("onFileModify still records user edits while a sync is running", () => {
		const plugin = new (S3SyncPlugin as any)();
		plugin.settings = {deviceId: "dev1", excludePatterns: ".obsidian,.trash"};
		plugin.localLedger = {"notes/a.md": fs(10, H1)};
		plugin.localTombstones = {};
		plugin.isSyncing = true;

		const mockFile = new TFile("notes/a.md");
		plugin.onFileModify(mockFile);

		expect(plugin.localLedger["notes/a.md"].version).toBe(10);
		expect(plugin.localLedger["notes/a.md"].parentHash).toBe(H1);
		expect(plugin.pendingPaths.has("notes/a.md")).toBe(true);
	});

	it("onFileCreate still records user-created files while a sync is running", () => {
		const plugin = new (S3SyncPlugin as any)();
		plugin.settings = {deviceId: "dev1", excludePatterns: ".obsidian,.trash"};
		plugin.localLedger = {};
		plugin.localTombstones = {};
		plugin.isSyncing = true;

		const mockFile = new TFile("notes/new.md");
		plugin.onFileCreate(mockFile);

		expect(plugin.localLedger["notes/new.md"]).toBeDefined();
		expect(plugin.pendingPaths.has("notes/new.md")).toBe(true);
	});

	it("onFileDelete still records user deletes while a sync is running", () => {
		const plugin = new (S3SyncPlugin as any)();
		plugin.settings = {deviceId: "dev1", excludePatterns: ".obsidian,.trash"};
		plugin.localLedger = {"notes/a.md": fs(10, H1)};
		plugin.localTombstones = {};
		plugin.isSyncing = true;

		const mockFile = new TFile("notes/a.md");
		plugin.onFileDelete(mockFile);

		expect(plugin.localTombstones["notes/a.md"]).toBeDefined();
		expect(plugin.pendingPaths.has("notes/a.md")).toBe(true);
	});

	it("ignores only a path currently suppressed by the sync engine", () => {
		const plugin = new (S3SyncPlugin as any)();
		plugin.settings = {deviceId: "dev1", excludePatterns: ".obsidian,.trash"};
		plugin.localLedger = {};
		plugin.localTombstones = {};
		plugin.isSyncing = true;
		plugin.beginSuppressPath("notes/a.md");

		const mockFile = new TFile("notes/a.md");
		plugin.onFileModify(mockFile);

		expect(plugin.localLedger["notes/a.md"]).toBeUndefined();
	});

	it("ignores a suppressed modify event when the disk hash matches the sync write", async () => {
		const plugin = new (S3SyncPlugin as any)();
		const syncBytes = new TextEncoder().encode("sync-write");
		const syncHash = await sha256Hex(syncBytes);
		plugin.settings = {deviceId: "dev1", excludePatterns: ".obsidian,.trash"};
		plugin.localLedger = {};
		plugin.localTombstones = {};
		plugin.pendingPaths = new Set();
		plugin.app.vault.adapter = {
			exists: jest.fn().mockResolvedValue(true),
			readBinary: jest.fn().mockResolvedValue(syncBytes.buffer),
		};
		plugin.beginSuppressPath("notes/a.md");
		plugin.endSuppressPath("notes/a.md", syncHash);

		plugin.onFileModify(new TFile("notes/a.md"));
		await new Promise(resolve => setTimeout(resolve, 0));

		expect(plugin.localLedger["notes/a.md"]).toBeUndefined();
		expect(plugin.pendingPaths.has("notes/a.md")).toBe(false);
		plugin.clearSuppressPath("notes/a.md");
	});

	it("records a suppressed-path modify when the disk hash differs from the sync write", async () => {
		const plugin = new (S3SyncPlugin as any)();
		const syncBytes = new TextEncoder().encode("sync-write");
		const userBytes = new TextEncoder().encode("user-edit");
		const syncHash = await sha256Hex(syncBytes);
		plugin.settings = {deviceId: "dev1", excludePatterns: ".obsidian,.trash"};
		plugin.localLedger = {};
		plugin.localTombstones = {};
		plugin.pendingPaths = new Set();
		plugin.app.vault.adapter = {
			exists: jest.fn().mockResolvedValue(true),
			readBinary: jest.fn().mockResolvedValue(userBytes.buffer),
		};
		plugin.beginSuppressPath("notes/a.md");
		plugin.endSuppressPath("notes/a.md", syncHash);

		plugin.onFileModify(new TFile("notes/a.md"));
		await new Promise(resolve => setTimeout(resolve, 0));

		expect(plugin.localLedger["notes/a.md"]).toBeDefined();
		expect(plugin.pendingPaths.has("notes/a.md")).toBe(true);
		plugin.clearSuppressPath("notes/a.md");
	});

	it("ignores root manifest, system files, and plugin storage prefix changes", () => {
		const plugin = new (S3SyncPlugin as any)();
		plugin.settings = {deviceId: "dev1", excludePatterns: "", storagePrefix: "_obsidian-sync/"};
		plugin.localLedger = {};
		plugin.localTombstones = {};
		plugin.isSyncing = false;

		plugin.onFileModify(new TFile("manifest.json"));
		plugin.onFileModify(new TFile(".DS_Store"));
		plugin.onFileModify(new TFile("_obsidian-sync/objects/aa/hash"));
		plugin.onFileModify(new TFile("project/manifest.json"));

		expect(plugin.localLedger["manifest.json"]).toBeUndefined();
		expect(plugin.localLedger[".DS_Store"]).toBeUndefined();
		expect(plugin.localLedger["_obsidian-sync/objects/aa/hash"]).toBeUndefined();
		expect(plugin.localLedger["project/manifest.json"]).toBeDefined();
	});
});

describe("Persisted state hygiene and pending paths", () => {
	it("removes non-sync target paths from ledger, tombstones, and pending paths", () => {
		const plugin = new (S3SyncPlugin as any)();
		plugin.settings = {deviceId: "dev1", excludePatterns: ".trash", storagePrefix: "_obsidian-sync/"};
		plugin.localLedger = {
			"notes/a.md": fs(1),
			"manifest.json": fs(1),
			"_obsidian-sync/internal.md": fs(1),
		};
		plugin.localTombstones = {
			".trash/deleted.md": tomb(2, 1),
			"notes/deleted.md": tomb(2, 1),
		};
		plugin.pendingPaths = new Set(["notes/a.md", "manifest.json", "_obsidian-sync/internal.md"]);

		plugin.sanitizePersistedState();

		expect(plugin.localLedger["notes/a.md"]).toBeDefined();
		expect(plugin.localLedger["manifest.json"]).toBeUndefined();
		expect(plugin.localLedger["_obsidian-sync/internal.md"]).toBeUndefined();
		expect(plugin.localTombstones[".trash/deleted.md"]).toBeUndefined();
		expect(plugin.localTombstones["notes/deleted.md"]).toBeDefined();
		expect([...plugin.pendingPaths]).toEqual(["notes/a.md"]);
	});

	it("adds deleted files to pending paths", () => {
		const plugin = new (S3SyncPlugin as any)();
		plugin.settings = {deviceId: "dev1", excludePatterns: "", storagePrefix: "_obsidian-sync/"};
		plugin.localLedger = {"notes/a.md": fs(10, H1)};
		plugin.localTombstones = {};
		plugin.pendingPaths = new Set();

		plugin.onFileDelete(new TFile("notes/a.md"));

		expect(plugin.pendingPaths.has("notes/a.md")).toBe(true);
	});

	it("keeps pending paths when manifest upload fails", async () => {
		const quickSpy = jest.spyOn(S3TransferManager.prototype, "quickSync").mockImplementation(async function (this: S3TransferManager) {
			this.localManifest = {"notes/a.md": fs(1)};
			return {
				uploaded: 0,
				downloaded: 0,
				deleted: 0,
				localDeleted: 0,
				localDeletedPaths: [],
				orphanCleaned: 0,
				failed: [{path: "manifest.json", error: "precondition failed"}],
				conflicts: [],
			};
		});
		const plugin = new (S3SyncPlugin as any)();
		plugin.settings = {
			accessKey: "ak", secretKey: "sk", endpoint: "https://s3.example.com", bucketName: "bucket",
			region: "us-east-1", deviceId: "dev1", deviceName: "test",
			excludePatterns: "", storagePrefix: "_obsidian-sync/",
		};
		plugin.localLedger = {"notes/a.md": fs(1)};
		plugin.localTombstones = {};
		plugin.pendingPaths = new Set(["notes/a.md"]);
		jest.spyOn(plugin, "waitForManifestRebaseBackoff").mockResolvedValue(undefined);

		await plugin.startSync(true, ["notes/a.md"]);

		expect(plugin.pendingPaths.has("notes/a.md")).toBe(true);
		quickSpy.mockRestore();
	});

	it("retries after a manifest conditional write conflict and clears pending on success", async () => {
		const quickSpy = jest.spyOn(S3TransferManager.prototype, "quickSync")
			.mockImplementationOnce(async function (this: S3TransferManager) {
				this.localManifest = {"notes/a.md": fs(1)};
				return {
					uploaded: 1,
					downloaded: 0,
					deleted: 0,
					localDeleted: 0,
					localDeletedPaths: [],
					orphanCleaned: 0,
					failed: [{path: "manifest.json", error: "PreconditionFailed: 412"}],
					conflicts: [],
				};
			})
			.mockImplementationOnce(async function (this: S3TransferManager) {
				this.localManifest = {"notes/a.md": fs(2)};
				return {
					uploaded: 1,
					downloaded: 0,
					deleted: 0,
					localDeleted: 0,
					localDeletedPaths: [],
					orphanCleaned: 0,
					failed: [],
					conflicts: [],
				};
			});
		const plugin = new (S3SyncPlugin as any)();
		plugin.settings = {
			accessKey: "ak", secretKey: "sk", endpoint: "https://s3.example.com", bucketName: "bucket",
			region: "us-east-1", deviceId: "dev1", deviceName: "test",
			excludePatterns: "", storagePrefix: "_obsidian-sync/",
		};
		plugin.localLedger = {"notes/a.md": fs(1)};
		plugin.localTombstones = {};
		plugin.pendingPaths = new Set(["notes/a.md"]);
		jest.spyOn(plugin, "waitForManifestRebaseBackoff").mockResolvedValue(undefined);

		await plugin.startSync(true, ["notes/a.md"]);

		expect(quickSpy).toHaveBeenCalledTimes(2);
		expect(quickSpy.mock.calls[0][5]).toEqual(["notes/a.md"]);
		expect(quickSpy.mock.calls[0][6]).toBe(false);
		expect(plugin.pendingPaths.has("notes/a.md")).toBe(false);
		expect(plugin.localLedger["notes/a.md"].version).toBe(2);
		quickSpy.mockRestore();
	});

	it("clears only successful pending snapshots after manifest success", async () => {
		const quickSpy = jest.spyOn(S3TransferManager.prototype, "quickSync").mockImplementation(async function (this: S3TransferManager) {
			this.localManifest = {"notes/a.md": fs(1)};
			return {
				uploaded: 0,
				downloaded: 0,
				deleted: 0,
				localDeleted: 0,
				localDeletedPaths: [],
				orphanCleaned: 0,
				failed: [],
				conflicts: [],
			};
		});
		const plugin = new (S3SyncPlugin as any)();
		plugin.settings = {
			accessKey: "ak", secretKey: "sk", endpoint: "https://s3.example.com", bucketName: "bucket",
			region: "us-east-1", deviceId: "dev1", deviceName: "test",
			excludePatterns: "", storagePrefix: "_obsidian-sync/",
		};
		plugin.localLedger = {"notes/a.md": fs(1)};
		plugin.localTombstones = {};
		plugin.pendingPaths = new Set(["notes/a.md", "notes/later.md"]);

		await plugin.startSync(true, ["notes/a.md"]);

		expect(plugin.pendingPaths.has("notes/a.md")).toBe(false);
		expect(plugin.pendingPaths.has("notes/later.md")).toBe(true);
		quickSpy.mockRestore();
	});

	it("keeps failed file paths pending even when manifest upload succeeds", async () => {
		const quickSpy = jest.spyOn(S3TransferManager.prototype, "quickSync").mockImplementation(async function (this: S3TransferManager) {
			this.localManifest = {"notes/a.md": fs(1), "notes/b.md": fs(1)};
			return {
				uploaded: 1,
				downloaded: 0,
				deleted: 0,
				localDeleted: 0,
				localDeletedPaths: [],
				orphanCleaned: 0,
				failed: [{path: "notes/b.md", error: "upload failed"}],
				conflicts: [],
			};
		});
		const plugin = new (S3SyncPlugin as any)();
		plugin.settings = {
			accessKey: "ak", secretKey: "sk", endpoint: "https://s3.example.com", bucketName: "bucket",
			region: "us-east-1", deviceId: "dev1", deviceName: "test",
			excludePatterns: "", storagePrefix: "_obsidian-sync/",
		};
		plugin.localLedger = {"notes/a.md": fs(1), "notes/b.md": fs(1)};
		plugin.localTombstones = {};
		plugin.pendingPaths = new Set(["notes/a.md", "notes/b.md"]);

		await plugin.startSync(true, ["notes/a.md", "notes/b.md"]);

		expect(plugin.pendingPaths.has("notes/a.md")).toBe(false);
		expect(plugin.pendingPaths.has("notes/b.md")).toBe(true);
		quickSpy.mockRestore();
	});
});

describe("Conflict modal", () => {
	it("resolves to both when closed without an explicit choice", () => {
		const onResolve = jest.fn();
		const modal = new ConflictModal({} as any, "notes/a.md", "local", "cloud", 1, 2, onResolve);

		modal.onClose();

		expect(onResolve).toHaveBeenCalledWith("both");
	});
});

// ══════════════════════════════════════════════════════════
// Orphan cleanup: tombstone generation for local deletes
// ══════════════════════════════════════════════════════════

describe("Orphan cleanup: tombstone generation for local deletes", () => {
	it("localDeletedPaths are populated in SyncResult", async () => {
		const {S3TransferManager} = require("../src/transfer");

		const mockVault = {
			adapter: {
				exists: jest.fn().mockResolvedValue(true),
				remove: jest.fn().mockResolvedValue(undefined),
				read: jest.fn(),
				readBinary: jest.fn(),
				write: jest.fn(),
				writeBinary: jest.fn(),
				list: jest.fn().mockResolvedValue({files: [], folders: []}),
				stat: jest.fn(),
			},
		} as any;

		const settings = {
			accessKey: "ak", secretKey: "sk", endpoint: "https://cos.example.com",
			region: "us-east-1", bucketName: "bucket", autoSync: false, syncInterval: 30,
			excludePatterns: "", deviceId: "dev1", deviceName: "test",
		};

		const manager = new S3TransferManager(mockVault, settings);
		manager.localManifest = {};

		(manager as any).client.send = jest.fn().mockResolvedValue({});

		const delta = {
			uploadQueue: [],
			downloadQueue: [],
			deleteQueue: [],
			localDeleteQueue: ["images/photo.png", "notes/old.md"],
			conflictQueue: [],
			hashStitched: [],
		};

		const cloudManifest = {
			version: "4.0", deviceId: "cloud", deviceName: "cloud",
			lastSyncTime: 0, files: {}, deleted: {},
		};

		const result = await manager.processQueues(
			delta, {}, {}, "dev1", "test", cloudManifest,
		);

		expect(result.localDeleted).toBe(2);
		expect(result.localDeletedPaths).toContain("images/photo.png");
		expect(result.localDeletedPaths).toContain("notes/old.md");
	});
});
