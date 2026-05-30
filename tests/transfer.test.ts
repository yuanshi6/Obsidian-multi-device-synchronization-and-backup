import {S3TransferManager} from "../src/transfer";
import {FileState, DeletedEntry, SyncManifest, sha256Hex} from "../src/scanner";
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
const STORAGE_PREFIX = "_obsidian-sync/";

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
	forcePathStyle: false,
	storagePrefix: STORAGE_PREFIX,
	enableConditionalWrite: true,
	enableOrphanCleanup: false,
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
			const actualBytes = new TextEncoder().encode("bin");
			const actualHash = await sha256Hex(actualBytes);
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
				version: "5.0", deviceId: "cloud", deviceName: "cloud",
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
			expect(manager.localManifest["a.md"].contentHash).toBe(actualHash);
			expect(manager.localManifest["a.md"].parentHash).toBe(actualHash);
			expect(manager.localManifest["a.md"].objectKey).toBe(`${STORAGE_PREFIX}objects/${actualHash.slice(0, 2)}/${actualHash}`);
			expect(sentCommands[0].Key).toBe(`${STORAGE_PREFIX}objects/${actualHash.slice(0, 2)}/${actualHash}`);
			expect(sentCommands[0].Metadata["content-sha256"]).toBe(actualHash);
		});

		it("uses the actual uploaded bytes hash when the scanned hash is stale", async () => {
			const freshBytes = new TextEncoder().encode("fresh-content");
			const freshHash = await sha256Hex(freshBytes);
			const localFiles = {"race-upload.md": dirty(0, H1, "")};
			const cloudFiles: Record<string, FileState> = {};
			const delta = {
				uploadQueue: ["race-upload.md"],
				downloadQueue: [],
				deleteQueue: [],
				localDeleteQueue: [],
				conflictQueue: [],
				hashStitched: [],
			};
			const cloudManifest: SyncManifest = {
				version: "5.0", deviceId: "cloud", deviceName: "cloud",
				lastSyncTime: 0, files: {}, deleted: {},
			};
			manager.localManifest = {"race-upload.md": dirty(0, H1, "")};
			(manager as any).vault.adapter.readBinary = jest.fn().mockResolvedValue(freshBytes.buffer);

			const sentCommands: any[] = [];
			(manager as any).client.send = jest.fn().mockImplementation((cmd: any) => {
				sentCommands.push(cmd);
				return Promise.resolve({ETag: `"etag-${cmd.Key}"`});
			});

			await manager.processQueues(
				delta, localFiles, cloudFiles, "dev1", "TestDevice", cloudManifest,
			);

			const expectedKey = `${STORAGE_PREFIX}objects/${freshHash.slice(0, 2)}/${freshHash}`;
			expect(sentCommands[0].Key).toBe(expectedKey);
			expect(sentCommands[0].Metadata["content-sha256"]).toBe(freshHash);
			expect(manager.localManifest["race-upload.md"].contentHash).toBe(freshHash);

			const manifestCmd = sentCommands[sentCommands.length - 1];
			const body = JSON.parse(manifestCmd.Body);
			expect(body.files["race-upload.md"].contentHash).toBe(freshHash);
			expect(body.files["race-upload.md"].objectKey).toBe(expectedKey);
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
				version: "5.0", deviceId: "cloud", deviceName: "cloud",
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

		it("repairs a cloud-missing clean local file without resetting its version", async () => {
			const localFiles = {"repair.md": fs(7, H1)};
			const delta = {
				uploadQueue: ["repair.md"],
				downloadQueue: [],
				deleteQueue: [],
				localDeleteQueue: [],
				conflictQueue: [],
				hashStitched: [],
			};
			const cloudManifest: SyncManifest = {
				version: "5.0", deviceId: "cloud", deviceName: "cloud",
				lastSyncTime: 0, files: {}, deleted: {},
			};
			manager.localManifest = {"repair.md": fs(7, H1)};

			const sentCommands: any[] = [];
			(manager as any).client.send = jest.fn().mockImplementation((cmd: any) => {
				sentCommands.push(cmd);
				return Promise.resolve({});
			});

			await manager.processQueues(
				delta, localFiles, {}, "dev1", "TestDevice", cloudManifest,
			);

			const manifestCmd = sentCommands[sentCommands.length - 1];
			const body = JSON.parse(manifestCmd.Body);
			expect(body.files["repair.md"].version).toBe(7);
			expect(manager.localManifest["repair.md"].version).toBe(7);
		});

		it("doesn't include raw unicode in Metadata and encodes paths", async () => {
			const localFiles = {"测试文件.md": dirty(0, H1, "")};
			const cloudFiles: Record<string, FileState> = {};
			const delta = {
				uploadQueue: ["测试文件.md"],
				downloadQueue: [], deleteQueue: [], localDeleteQueue: [], conflictQueue: [], hashStitched: [],
			};
			const cloudManifest: SyncManifest = {
				version: "5.0", deviceId: "cloud", deviceName: "cloud",
				lastSyncTime: 0, files: {}, deleted: {},
			};
			manager.localManifest = {"测试文件.md": dirty(0, H1, "")};

			const sentCommands: any[] = [];
			(manager as any).client.send = jest.fn().mockImplementation((cmd: any) => {
				sentCommands.push(cmd);
				return Promise.resolve({ETag: `"etag-${cmd.Key}"`});
			});

			await manager.processQueues(delta, localFiles, cloudFiles, "dev1", "TestDevice", cloudManifest);

			expect(sentCommands[0].Metadata["original-path-encoded"]).toBe(encodeURIComponent("测试文件.md"));
			expect(sentCommands[0].Metadata["x-amz-meta-original-path"]).toBeUndefined();
			expect(sentCommands[0].Metadata["original-path"]).toBeUndefined();
		});

		it("skips oldPath upload when missing but has tombstone (rename case)", async () => {
			const localFiles = {"old.md": dirty(0, H1, "")};
			const delta = {
				uploadQueue: ["old.md"],
				downloadQueue: [], deleteQueue: [], localDeleteQueue: [], conflictQueue: [], hashStitched: [],
			};
			const cloudManifest: SyncManifest = {
				version: "5.0", deviceId: "cloud", deviceName: "cloud",
				lastSyncTime: 0, files: {}, deleted: {},
			};
			manager.localManifest = {};
			(manager as any).vault.adapter.exists = jest.fn().mockResolvedValue(false);
			const localTombstones = {"old.md": tomb(1, 0)};

			const sentCommands: any[] = [];
			(manager as any).client.send = jest.fn().mockImplementation((cmd: any) => {
				sentCommands.push(cmd);
				return Promise.resolve({});
			});

			const result = await manager.processQueues(delta, localFiles, {}, "dev1", "TestDevice", cloudManifest, undefined, localTombstones);

			expect(result.failed).toHaveLength(0); // skipped without error
			expect(sentCommands.length).toBe(1); // only manifest
		});
	});

		describe("processQueues — download", () => {
			it("downloads files and records cloud version as the new local baseVersion", async () => {
				const currentLocalBytes = new TextEncoder().encode("bin");
				const currentLocalHash = await sha256Hex(currentLocalBytes);
				const downloadedBytes = new TextEncoder().encode("downloaded");
				const downloadedHash = await sha256Hex(downloadedBytes);
				const objectKey = `${STORAGE_PREFIX}objects/${downloadedHash.slice(0, 2)}/${downloadedHash}`;
				const localFiles = {"b.md": fs(1, currentLocalHash)};
				const cloudFiles = {"b.md": {...fs(2, downloadedHash, 2, downloadedHash, "dev2"), objectKey}};
			const delta = {
				uploadQueue: [],
				downloadQueue: ["b.md"],
				deleteQueue: [],
				localDeleteQueue: [],
				conflictQueue: [],
				hashStitched: [],
			};
			const cloudManifest: SyncManifest = {
				version: "5.0", deviceId: "cloud", deviceName: "cloud",
				lastSyncTime: 0, files: cloudFiles, deleted: {},
			};

				manager.localManifest = {"b.md": fs(1, currentLocalHash)};

			const requestedKeys: string[] = [];
			(manager as any).client.send = jest.fn().mockImplementation((cmd: any) => {
				requestedKeys.push(cmd.Key);
				if (cmd.Key === `${STORAGE_PREFIX}manifest.json`) return Promise.resolve({});
				return Promise.resolve({
					ETag: "\"file-etag\"",
					Body: {
						transformToByteArray: () => Promise.resolve(downloadedBytes),
					},
					Metadata: {
						"mtime": "200",
						"content-sha256": downloadedHash,
					},
				});
			});

			const result = await manager.processQueues(
				delta, localFiles, cloudFiles, "dev1", "TestDevice", cloudManifest,
			);

			expect(result.downloaded).toBe(1);
			expect(manager.localManifest["b.md"].version).toBe(2);
			expect(manager.localManifest["b.md"].baseVersion).toBe(2);
			expect(manager.localManifest["b.md"].contentHash).toBe(downloadedHash);
				expect(manager.localManifest["b.md"].parentHash).toBe(downloadedHash);
				expect(requestedKeys[0]).toBe(objectKey);
			});

			it("does not overwrite a file that changed locally after scan", async () => {
				const objectKey = `${STORAGE_PREFIX}objects/${H2.slice(0, 2)}/${H2}`;
				const localFiles = {"race.md": fs(1, H1)};
				const cloudFiles = {"race.md": {...fs(2, H2, 2, H2, "dev2"), objectKey}};
				const delta = {
					uploadQueue: [],
					downloadQueue: ["race.md"],
					deleteQueue: [],
					localDeleteQueue: [],
					conflictQueue: [],
					hashStitched: [],
				};
				const cloudManifest: SyncManifest = {
					version: "5.0", deviceId: "cloud", deviceName: "cloud",
					lastSyncTime: 0, files: cloudFiles, deleted: {},
				};
				manager.localManifest = {"race.md": fs(1, H1)};
				(manager as any).vault.adapter.readBinary = jest.fn().mockResolvedValue(new TextEncoder().encode("edited").buffer);
				const sentCommands: any[] = [];
				(manager as any).client.send = jest.fn().mockImplementation((cmd: any) => {
					sentCommands.push(cmd);
					return Promise.resolve({});
				});

				const result = await manager.processQueues(
					delta, localFiles, cloudFiles, "dev1", "TestDevice", cloudManifest,
				);

				expect(result.downloaded).toBe(0);
				expect(result.conflicts).toContain("race.md");
				expect((manager as any).vault.adapter.writeBinary).not.toHaveBeenCalled();
				expect(sentCommands.some(cmd => cmd.Key === objectKey && !cmd.Body)).toBe(false);
				const manifestCmd = sentCommands[sentCommands.length - 1];
				const body = JSON.parse(manifestCmd.Body);
				expect(body.files["race.md"].contentHash).toBe(H2);
			});

		it("falls back to the legacy path key and migrates old manifest entries to content-addressed objects", async () => {
			const legacyBytes = new TextEncoder().encode("legacy");
			const legacyHash = await sha256Hex(legacyBytes);
			const contentObjectKey = `${STORAGE_PREFIX}objects/${legacyHash.slice(0, 2)}/${legacyHash}`;
			const cloudFiles = {"legacy.md": fs(4, legacyHash, 4, legacyHash, "dev2")};
			const delta = {
				uploadQueue: [],
				downloadQueue: ["legacy.md"],
				deleteQueue: [],
				localDeleteQueue: [],
				conflictQueue: [],
				hashStitched: [],
			};
			const cloudManifest: SyncManifest = {
				version: "5.0", deviceId: "cloud", deviceName: "cloud",
				lastSyncTime: 0, files: cloudFiles, deleted: {},
			};
			manager.localManifest = {};

			const sentCommands: any[] = [];
			(manager as any).client.send = jest.fn().mockImplementation((cmd: any) => {
				sentCommands.push(cmd);
				if (cmd.Key === contentObjectKey && !cmd.Body) {
					return Promise.reject(Object.assign(new Error("missing"), {
						name: "NoSuchKey",
						$metadata: {httpStatusCode: 404},
					}));
				}
				if (cmd.Key === "legacy.md") {
					return Promise.resolve({
						ETag: "\"legacy-etag\"",
						Body: {transformToByteArray: () => Promise.resolve(legacyBytes)},
						Metadata: {"content-sha256": legacyHash},
					});
				}
				return Promise.resolve({ETag: `"etag-${cmd.Key}"`});
			});

			const result = await manager.processQueues(
				delta, {}, cloudFiles, "dev1", "TestDevice", cloudManifest,
			);

			expect(result.downloaded).toBe(1);
			expect(sentCommands.map(cmd => cmd.Key)).toContain("legacy.md");
			expect(sentCommands.some(cmd => cmd.Key === contentObjectKey && cmd.Body)).toBe(true);
			expect(manager.localManifest["legacy.md"].objectKey).toBe(contentObjectKey);
			const manifestCmd = sentCommands[sentCommands.length - 1];
			const body = JSON.parse(manifestCmd.Body);
			expect(body.files["legacy.md"].objectKey).toBe(contentObjectKey);
		});

		it("still falls back to the legacy path key when a migrated objectKey is missing", async () => {
			const legacyBytes = new TextEncoder().encode("legacy-with-inferred-key");
			const legacyHash = await sha256Hex(legacyBytes);
			const contentObjectKey = `${STORAGE_PREFIX}objects/${legacyHash.slice(0, 2)}/${legacyHash}`;
			const cloudFiles = {"legacy-inferred.md": {...fs(4, legacyHash, 4, legacyHash, "dev2"), objectKey: contentObjectKey}};
			const delta = {
				uploadQueue: [],
				downloadQueue: ["legacy-inferred.md"],
				deleteQueue: [],
				localDeleteQueue: [],
				conflictQueue: [],
				hashStitched: [],
			};
			const cloudManifest: SyncManifest = {
				version: "5.0", deviceId: "cloud", deviceName: "cloud",
				lastSyncTime: 0, files: cloudFiles, deleted: {},
			};
			manager.localManifest = {};

			const sentCommands: any[] = [];
			(manager as any).client.send = jest.fn().mockImplementation((cmd: any) => {
				sentCommands.push(cmd);
				if (cmd.Key === contentObjectKey && !cmd.Body) {
					return Promise.reject(Object.assign(new Error("missing"), {
						name: "NoSuchKey",
						$metadata: {httpStatusCode: 404},
					}));
				}
				if (cmd.Key === "legacy-inferred.md") {
					return Promise.resolve({
						ETag: "\"legacy-etag\"",
						Body: {transformToByteArray: () => Promise.resolve(legacyBytes)},
						Metadata: {"content-sha256": legacyHash},
					});
				}
				return Promise.resolve({ETag: `"etag-${cmd.Key}"`});
			});

			const result = await manager.processQueues(
				delta, {}, cloudFiles, "dev1", "TestDevice", cloudManifest,
			);

			expect(result.downloaded).toBe(1);
			expect(sentCommands.map(cmd => cmd.Key)).toEqual(expect.arrayContaining([contentObjectKey, "legacy-inferred.md"]));
			expect(sentCommands.some(cmd => cmd.Key === contentObjectKey && cmd.Body)).toBe(true);
			expect(manager.localManifest["legacy-inferred.md"].objectKey).toBe(contentObjectKey);
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
				version: "5.0", deviceId: "cloud", deviceName: "cloud",
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
				version: "5.0", deviceId: "cloud", deviceName: "cloud",
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

			it("does not delete a local file that changed after scan", async () => {
				const delta = {
					uploadQueue: [],
					downloadQueue: [],
					deleteQueue: [],
					localDeleteQueue: ["changed.md"],
					conflictQueue: [],
					hashStitched: [],
				};
				const localFiles = {"changed.md": fs(2, H1)};
				const cloudManifest: SyncManifest = {
					version: "5.0", deviceId: "cloud", deviceName: "cloud",
					lastSyncTime: 0, files: {}, deleted: {"changed.md": tomb(3, 2, "dev2")},
				};
				manager.localManifest = {"changed.md": fs(2, H1)};
				(manager as any).vault.adapter.readBinary = jest.fn().mockResolvedValue(new TextEncoder().encode("edited").buffer);
				(manager as any).client.send = jest.fn().mockResolvedValue({});

				const result = await manager.processQueues(
					delta, localFiles, {}, "dev1", "TestDevice", cloudManifest,
				);

				expect(result.localDeleted).toBe(0);
				expect(result.conflicts).toContain("changed.md");
				expect((manager as any).vault.adapter.remove).not.toHaveBeenCalled();
				expect(manager.localManifest["changed.md"]).toBeDefined();
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
				version: "5.0", deviceId: "cloud", deviceName: "cloud",
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
				version: "5.0", deviceId: "cloud", deviceName: "cloud",
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
			expect(manifestCmd.Key).toBe(`${STORAGE_PREFIX}manifest.json`);
			expect(manifestCmd.IfNoneMatch).toBe("*");
			const body = JSON.parse(manifestCmd.Body);
			expect(body.deleted["del.md"]).toBeDefined();
			expect(body.deleted["del.md"].baseVersion).toBe(2);
			expect(body.deleted["old-del.md"]).toBeDefined();
			expect(body.deviceId).toBe("dev1");
			expect(body.version).toBe("5.0");
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
			const contentBytes = new TextEncoder().encode("content");
			const contentHash = await sha256Hex(contentBytes);
			const objectKey = `${STORAGE_PREFIX}objects/${contentHash.slice(0, 2)}/${contentHash}`;
			const cloudFiles = {
				"re-downloaded.md": {...fs(2, contentHash), objectKey},
			};
			const cloudManifest: SyncManifest = {
				version: "5.0", deviceId: "cloud", deviceName: "cloud",
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
				if (cmd.Key === objectKey) {
					return Promise.resolve({
						Body: {transformToByteArray: () => Promise.resolve(contentBytes)},
						Metadata: {"content-sha256": contentHash},
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
				version: "5.0",
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
				version: "5.0", deviceId: "cloud", deviceName: "cloud",
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
			expect(manager.localManifest["conflict.md"].version).toBe(10);
			expect(manager.localManifest["conflict.md"].contentHash).toBe(H1);
		});

		it("publishes local-only tombstones into the cloud deleted map", async () => {
			const delta = {
				uploadQueue: [],
				downloadQueue: [],
				deleteQueue: [],
				localDeleteQueue: [],
				conflictQueue: [],
				hashStitched: [],
				publishTombstoneQueue: ["gone.md"],
			};
			const localTombstones = {"gone.md": tomb(8, 7)};
			const cloudManifest: SyncManifest = {
				version: "5.0", deviceId: "cloud", deviceName: "cloud",
				lastSyncTime: 0, files: {}, deleted: {},
			};
			manager.localManifest = {};

			const sentCommands: any[] = [];
			(manager as any).client.send = jest.fn().mockImplementation((cmd: any) => {
				sentCommands.push(cmd);
				return Promise.resolve({});
			});

			await manager.processQueues(
				delta, {}, {}, "dev1", "TestDevice", cloudManifest, undefined, localTombstones,
			);

			const manifestCmd = sentCommands[sentCommands.length - 1];
			const body = JSON.parse(manifestCmd.Body);
			expect(body.deleted["gone.md"]).toBeDefined();
			expect(body.deleted["gone.md"].baseVersion).toBe(7);
			expect(body.files["gone.md"]).toBeUndefined();
		});
	});

	describe("fetchCloudManifest safety", () => {
		it("returns an empty manifest only when the cloud manifest is missing", async () => {
			const missing = Object.assign(new Error("missing"), {
				name: "NoSuchKey",
				$metadata: {httpStatusCode: 404},
			});
			(manager as any).client.send = jest.fn().mockRejectedValue(missing);

			const manifest = await manager.fetchCloudManifest();

			expect(manifest.files).toEqual({});
			expect(manifest.deleted).toEqual({});
			expect((manager as any).manifestExists).toBe(false);
		});

		it("throws non-404 manifest errors instead of returning an empty manifest", async () => {
			const serviceError = Object.assign(new Error("temporary outage"), {
				name: "InternalError",
				$metadata: {httpStatusCode: 500},
			});
			(manager as any).client.send = jest.fn().mockRejectedValue(serviceError);

			await expect(manager.fetchCloudManifest()).rejects.toThrow("temporary outage");
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
				version: "5.0", deviceId: "cloud", deviceName: "cloud",
				lastSyncTime: 0, files: {}, deleted: {},
			};

			manager.localManifest = {"fail.md": dirty(0, H1, "")};

			let callCount = 0;
			(manager as any).client.send = jest.fn().mockImplementation((cmd: any) => {
				if (cmd.Key === `${STORAGE_PREFIX}manifest.json`) return Promise.resolve({});
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
				version: "5.0", deviceId: "cloud", deviceName: "cloud",
				lastSyncTime: 0, files: {}, deleted: {},
			};

			manager.localManifest = {"always-fail.md": dirty(0, H1, "")};

			(manager as any).client.send = jest.fn().mockImplementation((cmd: any) => {
				if (cmd.Key === `${STORAGE_PREFIX}manifest.json`) return Promise.resolve({});
				return Promise.reject(new Error("permanent failure"));
			});

			const result = await manager.processQueues(
				delta, localFiles, {}, "dev1", "TestDevice", cloudManifest,
			);

			expect(result.uploaded).toBe(0);
			expect(result.failed).toHaveLength(2);
			expect(result.failed[0].path).toBe("always-fail.md");
			expect(result.failed[1].path).toBe("manifest.json");
		});

		it("doesn't upload manifest when headers error thrown (ISO-8859-1)", async () => {
			const delta = {
				uploadQueue: ["bad-header.md"],
				downloadQueue: [], deleteQueue: [], localDeleteQueue: [], conflictQueue: [], hashStitched: [],
			};
			const localFiles = {"bad-header.md": dirty(0, H1, "")};
			const cloudManifest: SyncManifest = {
				version: "5.0", deviceId: "cloud", deviceName: "cloud",
				lastSyncTime: 0, files: {}, deleted: {},
			};
			manager.localManifest = {"bad-header.md": dirty(0, H1, "")};

			let manifestUploaded = false;
			(manager as any).client.send = jest.fn().mockImplementation((cmd: any) => {
				if (cmd.Key === `${STORAGE_PREFIX}manifest.json`) {
					manifestUploaded = true;
					return Promise.resolve({});
				}
				return Promise.reject(new Error("Failed to construct 'Headers': String contains non ISO-8859-1 code point."));
			});

			const result = await manager.processQueues(delta, localFiles, {}, "dev1", "TestDevice", cloudManifest);

			expect(result.failed).toHaveLength(2);
			expect(result.failed[0].path).toBe("bad-header.md");
			expect(result.failed[1].path).toBe("manifest.json");
			expect(manifestUploaded).toBe(false);
			expect(manager.localManifest["bad-header.md"].version).toBe(0); // unaltered
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

	describe("quickSync", () => {
		it("does not scan tombstone-only pending paths from disk", async () => {
			const m = createManager();
			const scanSpy = jest.fn().mockResolvedValue({});
			(m as any).scanner.scanPaths = scanSpy;
			jest.spyOn(m, "fetchCloudManifest").mockResolvedValue({
				version: "5.0",
				deviceId: "cloud",
				deviceName: "cloud",
				lastSyncTime: 0,
				files: {},
				deleted: {},
			});
			(m as any).client.send = jest.fn().mockResolvedValue({});

			await m.quickSync("dev1", 0, 3000, {"gone.md": tomb(3, 2)}, {}, ["gone.md"]);

			expect(scanSpy).toHaveBeenCalledWith([]);
		});
	});

	describe("fullSync safety", () => {
		it("refuses orphan cleanup when the safety switch is disabled", async () => {
			const m = createManager({...testSettings, enableOrphanCleanup: false});
			const sendSpy = jest.fn().mockResolvedValue({});
			(m as any).client.send = sendSpy;

			const count = await m.cleanOrphanFiles({
				version: "5.0",
				deviceId: "cloud",
				deviceName: "cloud",
				lastSyncTime: 0,
				files: {},
				deleted: {},
			});

			expect(count).toBe(0);
			expect(sendSpy).not.toHaveBeenCalled();
		});

		it("does not run orphan cleanup during normal full sync", async () => {
			const m = createManager();
			(m as any).scanner.scanAll = jest.fn().mockResolvedValue({});
			(m as any).client.send = jest.fn().mockImplementation((cmd: any) => {
				if (cmd.Key === `${STORAGE_PREFIX}manifest.json` && !cmd.Body) {
					return Promise.reject(Object.assign(new Error("missing"), {
						name: "NoSuchKey",
						$metadata: {httpStatusCode: 404},
					}));
				}
				return Promise.resolve({});
			});
			const cleanSpy = jest.spyOn(m, "cleanOrphanFiles");

			await m.fullSync("dev1", 0, undefined, {}, {});

			expect(cleanSpy).not.toHaveBeenCalled();
		});
	});
});
