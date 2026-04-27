import S3SyncPlugin from "../src/main";
import {DeletedEntry, FileState} from "../src/scanner";
import {TFile} from "obsidian";

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

// ── Helpers ──

function tomb(mtime: number, deletedBy = "dev1"): DeletedEntry {
	return {mtime, deletedBy};
}

function fs(lastPenDropTime: number, isUploaded = false, hash = "", lastModifiedBy = "dev1"): FileState {
	return {lastPenDropTime, isUploaded, hash, lastModifiedBy};
}

// ══════════════════════════════════════════════════════════
// Tombstone GC
// ══════════════════════════════════════════════════════════

describe("S3SyncPlugin — Tombstone GC", () => {
	it("removes tombstones older than 30 days", () => {
		const plugin = new (S3SyncPlugin as any)();
		const thirtyOneDaysAgo = Date.now() - 31 * 24 * 60 * 60 * 1000;
		const oneDayAgo = Date.now() - 1 * 24 * 60 * 60 * 1000;

		const tombstones = {
			"old.md": tomb(thirtyOneDaysAgo),
			"recent.md": tomb(oneDayAgo),
		};

		const result = plugin.runTombstoneGC(tombstones);
		expect(Object.keys(result)).toHaveLength(1);
		expect(result["recent.md"]).toBeDefined();
		expect(result["old.md"]).toBeUndefined();
	});

	it("keeps tombstones within 30 days", () => {
		const plugin = new (S3SyncPlugin as any)();
		const now = Date.now();
		const twentyNineDaysAgo = now - 29 * 24 * 60 * 60 * 1000;

		const tombstones = {
			"still-valid.md": tomb(twentyNineDaysAgo),
		};

		const result = plugin.runTombstoneGC(tombstones);
		expect(result["still-valid.md"]).toBeDefined();
	});

	it("returns empty for empty input", () => {
		const plugin = new (S3SyncPlugin as any)();
		const result = plugin.runTombstoneGC({});
		expect(Object.keys(result)).toHaveLength(0);
	});

	it("handles boundary: exactly 30 days ago", () => {
		const plugin = new (S3SyncPlugin as any)();
		const thirtyDaysAgo = Date.now() - 30 * 24 * 60 * 60 * 1000;

		const tombstones = {
			"boundary.md": tomb(thirtyDaysAgo),
		};

		const result = plugin.runTombstoneGC(tombstones);
		// 30 days exactly should be expired (now - mtime >= 30 days)
		expect(result["boundary.md"]).toBeUndefined();
	});
});

// ══════════════════════════════════════════════════════════
// Rename interceptor logic (unit test of the core logic)
// ══════════════════════════════════════════════════════════

describe("Rename interceptor logic", () => {
	it("transfers ledger entry from old path to new path", () => {
		const plugin = new (S3SyncPlugin as any)();
		plugin.settings = {deviceId: "dev1", excludePatterns: ""};
		plugin.localLedger = {
			"old/path.md": fs(100, true, "hash1", "dev1"),
		};
		plugin.localTombstones = {};

		// Use TFile from the mocked obsidian module so instanceof works
		const mockFile = new TFile("new/path.md");
		plugin.onFileRename(mockFile, "old/path.md");

		expect(plugin.localLedger["new/path.md"]).toBeDefined();
		expect(plugin.localLedger["new/path.md"].isUploaded).toBe(false);
		expect(plugin.localLedger["old/path.md"]).toBeUndefined();
	});

	it("clears old path tombstone on rename", () => {
		const plugin = new (S3SyncPlugin as any)();
		plugin.settings = {deviceId: "dev1", excludePatterns: ""};
		plugin.localLedger = {
			"old/path.md": fs(100, true, "hash1", "dev1"),
		};
		plugin.localTombstones = {
			"old/path.md": tomb(150),
		};

		const mockFile = new TFile("new/path.md");
		plugin.onFileRename(mockFile, "old/path.md");

		expect(plugin.localTombstones["old/path.md"]).toBeUndefined();
		expect(plugin.localLedger["new/path.md"]).toBeDefined();
	});

	it("creates new ledger entry when old path has no record", () => {
		const plugin = new (S3SyncPlugin as any)();
		plugin.settings = {deviceId: "dev1", excludePatterns: ""};
		plugin.localLedger = {};
		plugin.localTombstones = {};

		const mockFile = new TFile("new/path.md");
		plugin.onFileRename(mockFile, "old/path.md");

		expect(plugin.localLedger["new/path.md"]).toBeDefined();
		expect(plugin.localLedger["new/path.md"].isUploaded).toBe(false);
	});
});

// ══════════════════════════════════════════════════════════
// Delete interceptor logic
// ══════════════════════════════════════════════════════════

describe("Delete interceptor logic", () => {
	it("creates tombstone for .md file deletion", () => {
		const plugin = new (S3SyncPlugin as any)();
		plugin.settings = {deviceId: "dev1", excludePatterns: ""};
		plugin.localLedger = {
			"notes/a.md": fs(100, true),
		};
		plugin.localTombstones = {};

		const mockFile = new TFile("notes/a.md");
		plugin.onFileDelete(mockFile);

		expect(plugin.localTombstones["notes/a.md"]).toBeDefined();
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

// ══════════════════════════════════════════════════════════
// Modify interceptor logic
// ══════════════════════════════════════════════════════════

describe("Modify interceptor logic", () => {
	it("records file modification in ledger with isUploaded=false", () => {
		const plugin = new (S3SyncPlugin as any)();
		plugin.settings = {deviceId: "dev1", excludePatterns: ".obsidian,.trash"};
		plugin.localLedger = {};
		plugin.localTombstones = {};

		const mockFile = new TFile("notes/a.md");
		plugin.onFileModify(mockFile);

		expect(plugin.localLedger["notes/a.md"]).toBeDefined();
		expect(plugin.localLedger["notes/a.md"].isUploaded).toBe(false);
		expect(plugin.localLedger["notes/a.md"].lastModifiedBy).toBe("dev1");
	});

	it("updates existing ledger entry on re-modification", () => {
		const plugin = new (S3SyncPlugin as any)();
		plugin.settings = {deviceId: "dev1", excludePatterns: ".obsidian,.trash"};
		plugin.localLedger = {
			"notes/a.md": fs(100, true),
		};

		const mockFile = new TFile("notes/a.md");
		plugin.onFileModify(mockFile);

		expect(plugin.localLedger["notes/a.md"].isUploaded).toBe(false);
	});
});
