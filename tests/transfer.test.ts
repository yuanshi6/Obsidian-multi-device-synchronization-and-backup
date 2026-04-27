import {S3TransferManager, SyncResult} from "../src/transfer";
import {FileState, DeletedEntry, SyncManifest} from "../src/scanner";
import {S3BackupSettings} from "../src/settings";

// ── Mock AWS SDK ──

jest.mock("@aws-sdk/client-s3", () => {
	const send = jest.fn();
	return {
		S3Client: jest.fn().mockImplementation(() => ({send})),
		PutObjectCommand: jest.fn().mockImplementation((input: any) => input),
		GetObjectCommand: jest.fn().mockImplementation((input: any) => input),
		DeleteObjectCommand: jest.fn().mockImplementation((input: any) => input),
		ListObjectsV2Command: jest.fn().mockImplementation((input: any) => input),
	};
});

import {S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand, ListObjectsV2Command} from "@aws-sdk/client-s3";

// ── Helpers ──

function fs(lastPenDropTime: number, isUploaded = false, hash = "", lastModifiedBy = "dev1"): FileState {
	return {lastPenDropTime, isUploaded, hash, lastModifiedBy};
}

function tomb(mtime: number, deletedBy = "dev1"): DeletedEntry {
	return {mtime, deletedBy};
}

const testSettings: S3BackupSettings = {
	accessKey: "test-ak",
	secretKey: "test-sk",
	endpoint: "https://cos.ap-beijing.myqcloud.com",
	region: "ap-beijing",
	bucketName: "test-bucket",
	autoSync: false,
	syncInterval: 30,
	excludePatterns: ".obsidian,.trash",
	deviceId: "dev1",
	deviceName: "TestDevice",
};

function createManager(settings = testSettings): S3TransferManager {
	const mockVault = {
		adapter: {
			read: jest.fn().mockResolvedValue("content"),
			readBinary: jest.fn().mockResolvedValue(new ArrayBuffer(4)),
			write: jest.fn().mockResolvedValue(undefined),
			writeBinary: jest.fn().mockResolvedValue(undefined),
			exists: jest.fn().mockResolvedValue(true),
			remove: jest.fn().mockResolvedValue(undefined),
			list: jest.fn().mockResolvedValue({files: [], folders: []}),
			stat: jest.fn().mockResolvedValue({mtime: Date.now(), size: 100}),
		},
	} as any;
	return new S3TransferManager(mockVault, settings);
}

// ══════════════════════════════════════════════════════════
// S3TransferManager — processQueues
// ══════════════════════════════════════════════════════════

describe("S3TransferManager", () => {
	let manager: S3TransferManager;
	let mockSend: jest.Mock;

	beforeEach(() => {
		jest.clearAllMocks();
		manager = createManager();
		// Get the mock send from the S3Client constructor
		const s3Instances = (S3Client as jest.Mock).mock.results;
		// The send function is shared across all instances due to closure
		mockSend = (S3Client as jest.Mock).mock.calls[0] ? (() => {
			// Re-create to get fresh send
			const m = createManager();
			return (m as any).client.send;
		})() : jest.fn();
	});

	describe("processQueues — upload", () => {
		it("uploads files and marks them as isUploaded=true", async () => {
			const localFiles = {"a.md": fs(100, false)};
			const cloudFiles: Record<string, FileState> = {};
			const delta = {
				uploadQueue: ["a.md"],
				downloadQueue: [],
				deleteQueue: [],
				localDeleteQueue: [],
				conflictQueue: [],
				hashStitched: [],
			};
			const cloudManifest: SyncManifest = {
				version: "3.0", deviceId: "cloud", deviceName: "cloud",
				lastSyncTime: 0, files: {}, deleted: {},
			};

			manager.localManifest = {"a.md": fs(100, false)};

			// Mock the send to succeed
			(manager as any).client.send = jest.fn().mockResolvedValue({});

			const result = await manager.processQueues(
				delta, localFiles, cloudFiles, "dev1", "TestDevice", cloudManifest,
			);

			expect(result.uploaded).toBe(1);
			expect(manager.localManifest["a.md"].isUploaded).toBe(true);
		});
	});

	describe("processQueues — download", () => {
		it("downloads files and sets cloud lastPenDropTime in localManifest", async () => {
			const localFiles = {"b.md": fs(100, true)};
			const cloudFiles = {"b.md": fs(200, true, "hash1", "dev2")};
			const delta = {
				uploadQueue: [],
				downloadQueue: ["b.md"],
				deleteQueue: [],
				localDeleteQueue: [],
				conflictQueue: [],
				hashStitched: [],
			};
			const cloudManifest: SyncManifest = {
				version: "3.0", deviceId: "cloud", deviceName: "cloud",
				lastSyncTime: 0, files: cloudFiles, deleted: {},
			};

			manager.localManifest = {"b.md": fs(100, true)};

			(manager as any).client.send = jest.fn().mockImplementation((cmd: any) => {
				if (cmd.Key === "manifest.json") return Promise.resolve({});
				return Promise.resolve({
					Body: {
						transformToByteArray: () => Promise.resolve(new Uint8Array([116, 101, 115, 116])),
						transformToString: () => Promise.resolve("test content"),
					},
					Metadata: {"x-amz-meta-mtime": "200"},
				});
			});

			const result = await manager.processQueues(
				delta, localFiles, cloudFiles, "dev1", "TestDevice", cloudManifest,
			);

			expect(result.downloaded).toBe(1);
			// Echo defense: localManifest should have cloud's lastPenDropTime
			expect(manager.localManifest["b.md"].lastPenDropTime).toBe(200);
			expect(manager.localManifest["b.md"].isUploaded).toBe(true);
		});
	});

	describe("processQueues — cloud delete", () => {
		it("deletes files from cloud", async () => {
			const delta = {
				uploadQueue: [],
				downloadQueue: [],
				deleteQueue: ["c.md"],
				localDeleteQueue: [],
				conflictQueue: [],
				hashStitched: [],
			};
			const cloudManifest: SyncManifest = {
				version: "3.0", deviceId: "cloud", deviceName: "cloud",
				lastSyncTime: 0, files: {}, deleted: {},
			};

			manager.localManifest = {};

			(manager as any).client.send = jest.fn().mockResolvedValue({});

			const result = await manager.processQueues(
				delta, {}, {}, "dev1", "TestDevice", cloudManifest,
			);

			expect(result.deleted).toBe(1);
		});
	});

	describe("processQueues — local delete", () => {
		it("deletes local files that exist", async () => {
			const delta = {
				uploadQueue: [],
				downloadQueue: [],
				deleteQueue: [],
				localDeleteQueue: ["d.md"],
				conflictQueue: [],
				hashStitched: [],
			};
			const cloudManifest: SyncManifest = {
				version: "3.0", deviceId: "cloud", deviceName: "cloud",
				lastSyncTime: 0, files: {}, deleted: {},
			};

			manager.localManifest = {};

			(manager as any).client.send = jest.fn().mockResolvedValue({});

			const result = await manager.processQueues(
				delta, {}, {}, "dev1", "TestDevice", cloudManifest,
			);

			expect(result.localDeleted).toBe(1);
		});

		it("skips local files that don't exist", async () => {
			const delta = {
				uploadQueue: [],
				downloadQueue: [],
				deleteQueue: [],
				localDeleteQueue: ["missing.md"],
				conflictQueue: [],
				hashStitched: [],
			};
			const cloudManifest: SyncManifest = {
				version: "3.0", deviceId: "cloud", deviceName: "cloud",
				lastSyncTime: 0, files: {}, deleted: {},
			};

			manager.localManifest = {};

			(manager as any).client.send = jest.fn().mockResolvedValue({});
			(manager as any).vault.adapter.exists = jest.fn().mockResolvedValue(false);

			const result = await manager.processQueues(
				delta, {}, {}, "dev1", "TestDevice", cloudManifest,
			);

			expect(result.localDeleted).toBe(0);
		});
	});

	describe("processQueues — manifest upload", () => {
		it("uploads manifest with merged deleted entries", async () => {
			const delta = {
				uploadQueue: [],
				downloadQueue: [],
				deleteQueue: ["del.md"],
				localDeleteQueue: ["local-del.md"],
				conflictQueue: [],
				hashStitched: [],
			};
			const recentTime = Date.now() - 1000;
			const cloudManifest: SyncManifest = {
				version: "3.0", deviceId: "cloud", deviceName: "cloud",
				lastSyncTime: 0, files: {}, deleted: {"old-del.md": tomb(recentTime)},
			};

			manager.localManifest = {};

			const sentCommands: any[] = [];
			(manager as any).client.send = jest.fn().mockImplementation((cmd: any) => {
				sentCommands.push(cmd);
				return Promise.resolve({});
			});

			await manager.processQueues(
				delta, {}, {}, "dev1", "TestDevice", cloudManifest,
			);

			// Last command should be the manifest upload
			const manifestCmd = sentCommands[sentCommands.length - 1];
			expect(manifestCmd.Key).toBe("manifest.json");
			const body = JSON.parse(manifestCmd.Body);
			expect(body.deleted["del.md"]).toBeDefined();
			expect(body.deleted["local-del.md"]).toBeDefined();
			expect(body.deleted["old-del.md"]).toBeDefined();
			expect(body.deviceId).toBe("dev1");
			expect(body.version).toBe("3.0");
		});

		it("removes deleted entries for uploaded/downloaded files", async () => {
			const delta = {
				uploadQueue: ["re-uploaded.md"],
				downloadQueue: ["re-downloaded.md"],
				deleteQueue: [],
				localDeleteQueue: [],
				conflictQueue: [],
				hashStitched: [],
			};
			const localFiles = {
				"re-uploaded.md": fs(100, false),
			};
			const cloudFiles = {
				"re-downloaded.md": fs(200, true),
			};
			const cloudManifest: SyncManifest = {
				version: "3.0", deviceId: "cloud", deviceName: "cloud",
				lastSyncTime: 0, files: cloudFiles,
				deleted: {
					"re-uploaded.md": tomb(50),
					"re-downloaded.md": tomb(50),
				},
			};

			manager.localManifest = {
				"re-uploaded.md": fs(100, false),
			};

			(manager as any).client.send = jest.fn().mockImplementation((cmd: any) => {
				if (cmd.Key === "manifest.json") return Promise.resolve({});
				if (cmd.Key === "re-downloaded.md") {
					return Promise.resolve({
						Body: {transformToString: () => Promise.resolve("content"), transformToByteArray: () => Promise.resolve(new Uint8Array())},
						Metadata: {"x-amz-meta-mtime": "200"},
					});
				}
				return Promise.resolve({});
			});

			const sentCommands: any[] = [];
			(manager as any).client.send = jest.fn().mockImplementation((cmd: any) => {
				sentCommands.push(cmd);
				if (cmd.Key === "manifest.json") return Promise.resolve({});
				if (cmd.Key === "re-downloaded.md") {
					return Promise.resolve({
						Body: {transformToString: () => Promise.resolve("content"), transformToByteArray: () => Promise.resolve(new Uint8Array())},
						Metadata: {"x-amz-meta-mtime": "200"},
					});
				}
				return Promise.resolve({});
			});

			await manager.processQueues(
				delta, localFiles, cloudFiles, "dev1", "TestDevice", cloudManifest,
			);

			const manifestCmd = sentCommands[sentCommands.length - 1];
			const body = JSON.parse(manifestCmd.Body);
			expect(body.deleted["re-uploaded.md"]).toBeUndefined();
			expect(body.deleted["re-downloaded.md"]).toBeUndefined();
		});

		it("expires deleted entries older than 30 days", async () => {
			const thirtyOneDaysAgo = Date.now() - 31 * 24 * 60 * 60 * 1000;
			const delta = {
				uploadQueue: [],
				downloadQueue: [],
				deleteQueue: [],
				localDeleteQueue: [],
				conflictQueue: [],
				hashStitched: [],
			};
			const cloudManifest: SyncManifest = {
				version: "3.0", deviceId: "cloud", deviceName: "cloud",
				lastSyncTime: 0, files: {},
				deleted: {
					"expired.md": tomb(thirtyOneDaysAgo),
					"recent.md": tomb(Date.now() - 1000),
				},
			};

			manager.localManifest = {};

			const sentCommands: any[] = [];
			(manager as any).client.send = jest.fn().mockImplementation((cmd: any) => {
				sentCommands.push(cmd);
				return Promise.resolve({});
			});

			await manager.processQueues(
				delta, {}, {}, "dev1", "TestDevice", cloudManifest,
			);

			const manifestCmd = sentCommands[sentCommands.length - 1];
			const body = JSON.parse(manifestCmd.Body);
			expect(body.deleted["expired.md"]).toBeUndefined();
			expect(body.deleted["recent.md"]).toBeDefined();
		});
	});

	describe("processQueues — retry on failure", () => {
		it("retries failed uploads up to MAX_RETRIES", async () => {
			const delta = {
				uploadQueue: ["fail.md"],
				downloadQueue: [],
				deleteQueue: [],
				localDeleteQueue: [],
				conflictQueue: [],
				hashStitched: [],
			};
			const localFiles = {"fail.md": fs(100, false)};
			const cloudManifest: SyncManifest = {
				version: "3.0", deviceId: "cloud", deviceName: "cloud",
				lastSyncTime: 0, files: {}, deleted: {},
			};

			manager.localManifest = {"fail.md": fs(100, false)};

			let callCount = 0;
			(manager as any).client.send = jest.fn().mockImplementation((cmd: any) => {
				if (cmd.Key === "manifest.json") return Promise.resolve({});
				callCount++;
				if (callCount <= 2) return Promise.reject(new Error("network error"));
				return Promise.resolve({});
			});

			const result = await manager.processQueues(
				delta, localFiles, {}, "dev1", "TestDevice", cloudManifest,
			);

			expect(result.uploaded).toBe(1);
		});

		it("records failure after MAX_RETRIES exhausted", async () => {
			const delta = {
				uploadQueue: ["always-fail.md"],
				downloadQueue: [],
				deleteQueue: [],
				localDeleteQueue: [],
				conflictQueue: [],
				hashStitched: [],
			};
			const localFiles = {"always-fail.md": fs(100, false)};
			const cloudManifest: SyncManifest = {
				version: "3.0", deviceId: "cloud", deviceName: "cloud",
				lastSyncTime: 0, files: {}, deleted: {},
			};

			manager.localManifest = {"always-fail.md": fs(100, false)};

			(manager as any).client.send = jest.fn().mockImplementation((cmd: any) => {
				if (cmd.Key === "manifest.json") return Promise.resolve({});
				return Promise.reject(new Error("permanent failure"));
			});

			const result = await manager.processQueues(
				delta, localFiles, {}, "dev1", "TestDevice", cloudManifest,
			);

			expect(result.uploaded).toBe(0);
			expect(result.failed).toHaveLength(1);
			expect(result.failed[0].path).toBe("always-fail.md");
		});
	});

	describe("isSyncing lock", () => {
		it("prevents concurrent fullSync", async () => {
			const m = createManager();
			expect(m.isSyncing).toBe(false);

			// Mock scanner and S3 to hang
			(m as any).scanner.scanAll = jest.fn().mockImplementation(() => new Promise(() => {}));
			(m as any).client.send = jest.fn().mockResolvedValue({});

			const firstSync = m.fullSync("dev1", 0);
			expect(m.isSyncing).toBe(true);

			const secondResult = await m.fullSync("dev1", 0);
			expect(secondResult.uploaded).toBe(0);
			expect(secondResult.failed).toHaveLength(0);

			// Let the first one finish (it won't because scanAll hangs, but we can force it)
			// Just verify the lock is working
		});
	});
});
