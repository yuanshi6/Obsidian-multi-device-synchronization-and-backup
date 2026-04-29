import {S3TransferManager} from "../src/transfer";
import {FileState, DeletedEntry, SyncManifest} from "../src/scanner";
import {S3BackupSettings} from "../src/settings";

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

const H1 = "a".repeat(64);
const H2 = "b".repeat(64);

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
			readBinary: jest.fn().mockResolvedValue(new TextEncoder().encode("bin").buffer),
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

describe("S3TransferManager", () => {
	let manager: S3TransferManager;

	beforeEach(() => {
		jest.clearAllMocks();
		manager = createManager();
	});

	describe("processQueues — upload", () => {
		it("uploads files and records the confirmed next version", async () => {
			const localFiles = {"a.md": dirty(0, H1, "")};
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
				version: "4.0", deviceId: "cloud", deviceName: "cloud",
				lastSyncTime: 0, files: {}, deleted: {},
			};

			manager.localManifest = {"a.md": dirty(0, H1, "")};

			const sentCommands: any[] = [];
			(manager as any).client.send = jest.fn().mockImplementation((cmd: any) => {
				sentCommands.push(cmd);
				return Promise.resolve({ETag: `"etag-${cmd.Key}"`});
			});

			const result = await manager.processQueues(
				delta, localFiles, cloudFiles, "dev1", "TestDevice", cloudManifest,
			);

			expect(result.uploaded).toBe(1);
			expect(manager.localManifest["a.md"].version).toBe(1);
			expect(manager.localManifest["a.md"].baseVersion).toBe(1);
			expect(manager.localManifest["a.md"].parentHash).toBe(H1);
			expect(sentCommands[0].Metadata["x-amz-meta-content-sha256"]).toBe(H1);
		});

		it("increments from the current cloud version on upload", async () => {
			const localFiles = {"a.md": dirty(2, H2, H1)};
			const cloudFiles = {"a.md": fs(2, H1)};
			const delta = {
				uploadQueue: ["a.md"],
				downloadQueue: [],
				deleteQueue: [],
				localDeleteQueue: [],
				conflictQueue: [],
				hashStitched: [],
			};
			const cloudManifest: SyncManifest = {
				version: "4.0", deviceId: "cloud", deviceName: "cloud",
				lastSyncTime: 0, files: cloudFiles, deleted: {},
			};

			manager.localManifest = {"a.md": dirty(2, H2, H1)};
			(manager as any).client.send = jest.fn().mockResolvedValue({});

			await manager.processQueues(
				delta, localFiles, cloudFiles, "dev1", "TestDevice", cloudManifest,
			);

			expect(manager.localManifest["a.md"].version).toBe(3);
			expect(manager.localManifest["a.md"].baseVersion).toBe(3);
		});
	});

	describe("processQueues — download", () => {
		it("downloads files and records cloud version as the new local baseVersion", async () => {
			const localFiles = {"b.md": fs(1, H1)};
			const cloudFiles = {"b.md": fs(2, H2, 2, H2, "dev2")};
			const delta = {
				uploadQueue: [],
				downloadQueue: ["b.md"],
				deleteQueue: [],
				localDeleteQueue: [],
				conflictQueue: [],
				hashStitched: [],
			};
			const cloudManifest: SyncManifest = {
				version: "4.0", deviceId: "cloud", deviceName: "cloud",
				lastSyncTime: 0, files: cloudFiles, deleted: {},
			};

			manager.localManifest = {"b.md": fs(1, H1)};

			(manager as any).client.send = jest.fn().mockImplementation((cmd: any) => {
				if (cmd.Key === "manifest.json") return Promise.resolve({});
				return Promise.resolve({
					ETag: "\"file-etag\"",
					Body: {
						transformToByteArray: () => Promise.resolve(new TextEncoder().encode("downloaded")),
					},
					Metadata: {
						"x-amz-meta-mtime": "200",
						"x-amz-meta-content-sha256": H2,
					},
				});
			});

			const result = await manager.processQueues(
				delta, localFiles, cloudFiles, "dev1", "TestDevice", cloudManifest,
			);

			expect(result.downloaded).toBe(1);
			expect(manager.localManifest["b.md"].version).toBe(2);
			expect(manager.localManifest["b.md"].baseVersion).toBe(2);
			expect(manager.localManifest["b.md"].contentHash).toBe(H2);
			expect(manager.localManifest["b.md"].parentHash).toBe(H2);
		});
	});

	describe("processQueues — deletes", () => {
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
				version: "4.0", deviceId: "cloud", deviceName: "cloud",
				lastSyncTime: 0, files: {"c.md": fs(2, H1)}, deleted: {},
			};

			manager.localManifest = {};
			(manager as any).client.send = jest.fn().mockResolvedValue({});

			const result = await manager.processQueues(
				delta, {}, cloudManifest.files, "dev1", "TestDevice", cloudManifest,
			);

			expect(result.deleted).toBe(1);
			expect(manager.localManifest["c.md"]).toBeUndefined();
		});

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
				version: "4.0", deviceId: "cloud", deviceName: "cloud",
				lastSyncTime: 0, files: {}, deleted: {"d.md": tomb(3, 2, "dev2")},
			};

			manager.localManifest = {"d.md": fs(2, H1)};
			(manager as any).client.send = jest.fn().mockResolvedValue({});

			const result = await manager.processQueues(
				delta, {}, {}, "dev1", "TestDevice", cloudManifest,
			);

			expect(result.localDeleted).toBe(1);
			expect(result.localDeletedPaths).toContain("d.md");
			expect(manager.localManifest["d.md"]).toBeUndefined();
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
				version: "4.0", deviceId: "cloud", deviceName: "cloud",
				lastSyncTime: 0, files: {}, deleted: {"missing.md": tomb(3, 2, "dev2")},
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
		it("uploads manifest with merged deleted entries and no fixed tombstone expiry", async () => {
			const delta = {
				uploadQueue: [],
				downloadQueue: [],
				deleteQueue: ["del.md"],
				localDeleteQueue: [],
				conflictQueue: [],
				hashStitched: [],
			};
			const ancientTime = Date.now() - 365 * 24 * 60 * 60 * 1000;
			const cloudFiles = {"del.md": fs(2, H1)};
			const cloudManifest: SyncManifest = {
				version: "4.0", deviceId: "cloud", deviceName: "cloud",
				lastSyncTime: 0, files: cloudFiles,
				deleted: {"old-del.md": {...tomb(2, 1), mtime: ancientTime}},
			};

			manager.localManifest = {};

			const sentCommands: any[] = [];
			(manager as any).client.send = jest.fn().mockImplementation((cmd: any) => {
				sentCommands.push(cmd);
				return Promise.resolve({});
			});

			await manager.processQueues(
				delta, {}, cloudFiles, "dev1", "TestDevice", cloudManifest,
			);

			const manifestCmd = sentCommands[sentCommands.length - 1];
			expect(manifestCmd.Key).toBe("manifest.json");
			expect(manifestCmd.IfNoneMatch).toBe("*");
			const body = JSON.parse(manifestCmd.Body);
			expect(body.deleted["del.md"]).toBeDefined();
			expect(body.deleted["del.md"].baseVersion).toBe(2);
			expect(body.deleted["old-del.md"]).toBeDefined();
			expect(body.deviceId).toBe("dev1");
			expect(body.version).toBe("4.0");
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
				"re-uploaded.md": dirty(0, H1, ""),
			};
			const cloudFiles = {
				"re-downloaded.md": fs(2, H2),
			};
			const cloudManifest: SyncManifest = {
				version: "4.0", deviceId: "cloud", deviceName: "cloud",
				lastSyncTime: 0, files: cloudFiles,
				deleted: {
					"re-uploaded.md": tomb(1, 0),
					"re-downloaded.md": tomb(1, 0),
				},
			};

			manager.localManifest = {
				"re-uploaded.md": dirty(0, H1, ""),
			};

			const sentCommands: any[] = [];
			(manager as any).client.send = jest.fn().mockImplementation((cmd: any) => {
				sentCommands.push(cmd);
				if (cmd.Key === "re-downloaded.md") {
					return Promise.resolve({
						Body: {transformToByteArray: () => Promise.resolve(new TextEncoder().encode("content"))},
						Metadata: {"x-amz-meta-content-sha256": H2},
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

		it("uses IfMatch when a manifest ETag is known", async () => {
			(manager as any).manifestETag = "\"manifest-etag\"";
			(manager as any).manifestExists = true;
			const sentCommands: any[] = [];
			(manager as any).client.send = jest.fn().mockImplementation((cmd: any) => {
				sentCommands.push(cmd);
				return Promise.resolve({ETag: "\"next-etag\""});
			});

			await manager.uploadManifest({
				version: "4.0",
				deviceId: "dev1",
				deviceName: "TestDevice",
				lastSyncTime: 0,
				files: {},
				deleted: {},
			});

			expect(sentCommands[0].IfMatch).toBe("\"manifest-etag\"");
			expect(sentCommands[0].IfNoneMatch).toBeUndefined();
			expect((manager as any).manifestETag).toBe("\"next-etag\"");
		});

		it("preserves cloud state for conflicted paths when writing manifest", async () => {
			const delta = {
				uploadQueue: [],
				downloadQueue: [],
				deleteQueue: [],
				localDeleteQueue: [],
				conflictQueue: ["conflict.md"],
				hashStitched: [],
			};
			const cloudFiles = {"conflict.md": fs(11, H2, 11, H2, "dev2")};
			const cloudManifest: SyncManifest = {
				version: "4.0", deviceId: "cloud", deviceName: "cloud",
				lastSyncTime: 0, files: cloudFiles, deleted: {},
			};

			manager.localManifest = {"conflict.md": dirty(10, H1, H2)};
			const sentCommands: any[] = [];
			(manager as any).client.send = jest.fn().mockImplementation((cmd: any) => {
				sentCommands.push(cmd);
				return Promise.resolve({});
			});

			await manager.processQueues(
				delta, {"conflict.md": dirty(10, H1, H2)}, cloudFiles, "dev1", "TestDevice", cloudManifest,
			);

			const manifestCmd = sentCommands[sentCommands.length - 1];
			const body = JSON.parse(manifestCmd.Body);
			expect(body.files["conflict.md"].version).toBe(11);
			expect(body.files["conflict.md"].contentHash).toBe(H2);
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
			const localFiles = {"fail.md": dirty(0, H1, "")};
			const cloudManifest: SyncManifest = {
				version: "4.0", deviceId: "cloud", deviceName: "cloud",
				lastSyncTime: 0, files: {}, deleted: {},
			};

			manager.localManifest = {"fail.md": dirty(0, H1, "")};

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
			expect(callCount).toBe(3);
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
			const localFiles = {"always-fail.md": dirty(0, H1, "")};
			const cloudManifest: SyncManifest = {
				version: "4.0", deviceId: "cloud", deviceName: "cloud",
				lastSyncTime: 0, files: {}, deleted: {},
			};

			manager.localManifest = {"always-fail.md": dirty(0, H1, "")};

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

			(m as any).scanner.scanAll = jest.fn().mockImplementation(() => new Promise(() => {}));
			(m as any).client.send = jest.fn().mockResolvedValue({});

			m.fullSync("dev1", 0);
			expect(m.isSyncing).toBe(true);

			const secondResult = await m.fullSync("dev1", 0);
			expect(secondResult.uploaded).toBe(0);
			expect(secondResult.failed).toHaveLength(0);
		});
	});
});
