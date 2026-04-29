import S3SyncPlugin from "../src/main";
import {DeletedEntry, FileState} from "../src/scanner";
import {TFile} from "obsidian";

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
	};
});

const H1 = "a".repeat(64);
const H2 = "b".repeat(64);

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

function fs(version: number, contentHash = H1, baseVersion = version, parentHash = contentHash, lastModifiedBy = "dev1"): FileState {
	return {
		fileId: "file-id",
		version,
		baseVersion,
		contentHash,
		mtime: version,
		lastModifiedBy,
		parentHash,
	};
}

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
});

describe("Delete interceptor logic", () => {
	it("creates versioned tombstone for .md file deletion", () => {
		const plugin = new (S3SyncPlugin as any)();
		plugin.settings = {deviceId: "dev1", excludePatterns: ""};
		plugin.localLedger = {
			"notes/a.md": fs(10, H1),
		};
		plugin.localTombstones = {};

		const mockFile = new TFile("notes/a.md");
		plugin.onFileDelete(mockFile);

		expect(plugin.localTombstones["notes/a.md"]).toBeDefined();
		expect(plugin.localTombstones["notes/a.md"].baseVersion).toBe(10);
		expect(plugin.localTombstones["notes/a.md"].version).toBe(11);
		expect(plugin.localLedger["notes/a.md"]).toBeUndefined();
	});

	it("ignores non-.md file deletion", () => {
		const plugin = new (S3SyncPlugin as any)();
		plugin.settings = {deviceId: "dev1", excludePatterns: ""};
		plugin.localTombstones = {};

		const mockFile = new TFile("images/photo.png");
		plugin.onFileDelete(mockFile);

		expect(plugin.localTombstones["images/photo.png"]).toBeUndefined();
	});
});

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

describe("Sync-Lock: Observer ignores events during sync", () => {
	it("onFileModify skips when isSyncing=true", () => {
		const plugin = new (S3SyncPlugin as any)();
		plugin.settings = {deviceId: "dev1", excludePatterns: ".obsidian,.trash"};
		plugin.localLedger = {"notes/a.md": fs(10, H1)};
		plugin.isSyncing = true;

		const mockFile = new TFile("notes/a.md");
		plugin.onFileModify(mockFile);

		expect(plugin.localLedger["notes/a.md"].version).toBe(10);
		expect(plugin.localLedger["notes/a.md"].parentHash).toBe(H1);
	});

	it("onFileCreate skips when isSyncing=true", () => {
		const plugin = new (S3SyncPlugin as any)();
		plugin.settings = {deviceId: "dev1", excludePatterns: ".obsidian,.trash"};
		plugin.localLedger = {};
		plugin.isSyncing = true;

		const mockFile = new TFile("notes/new.md");
		plugin.onFileCreate(mockFile);

		expect(plugin.localLedger["notes/new.md"]).toBeUndefined();
	});

	it("onFileDelete skips when isSyncing=true", () => {
		const plugin = new (S3SyncPlugin as any)();
		plugin.settings = {deviceId: "dev1", excludePatterns: ".obsidian,.trash"};
		plugin.localLedger = {"notes/a.md": fs(10, H1)};
		plugin.localTombstones = {};
		plugin.isSyncing = true;

		const mockFile = new TFile("notes/a.md");
		plugin.onFileDelete(mockFile);

		expect(plugin.localTombstones["notes/a.md"]).toBeUndefined();
	});

	it("onFileModify processes when isSyncing=false", () => {
		const plugin = new (S3SyncPlugin as any)();
		plugin.settings = {deviceId: "dev1", excludePatterns: ".obsidian,.trash"};
		plugin.localLedger = {};
		plugin.isSyncing = false;

		const mockFile = new TFile("notes/a.md");
		plugin.onFileModify(mockFile);

		expect(plugin.localLedger["notes/a.md"]).toBeDefined();
		expect(plugin.localLedger["notes/a.md"].baseVersion).toBe(0);
	});
});

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
