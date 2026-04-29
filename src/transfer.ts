import {DeleteObjectCommand, GetObjectCommand, ListObjectsV2Command, ListObjectsV2CommandOutput, PutObjectCommand, S3Client} from "@aws-sdk/client-s3";
import {Notice, Vault} from "obsidian";
import {S3BackupSettings} from "./settings";
import {
	computeSyncDelta,
	createDeletedEntry,
	createSyncedFileState,
	DeletedEntry,
	FileState,
	FileScanner,
	isTrustedContentHash,
	mergeDiskWithLedger,
	normalizeDeletedEntry,
	normalizeFileState,
	normalizeSyncPath,
	sha256Hex,
	SyncDelta,
	SyncManifest,
} from "./scanner";

const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 2000;
const MAX_CONCURRENCY = 3;

// ── 二进制后缀识别 ──
const BINARY_EXTS = new Set(["png", "jpg", "jpeg", "gif", "webp", "pdf", "zip", "mp4", "mp3", "bmp", "svg", "ico", "wav", "ogg", "m4a", "webm", "mov", "avi"]);

function isBinaryPath(path: string): boolean {
	const dotIdx = path.lastIndexOf(".");
	if (dotIdx === -1) return false;
	const ext = path.slice(dotIdx + 1).toLowerCase();
	return BINARY_EXTS.has(ext);
}

function cleanEndpoint(endpoint: string, bucketName: string): string {
	let cleaned = endpoint.trim();
	if (!/^https?:\/\//.test(cleaned)) {
		cleaned = "https://" + cleaned;
	}
	cleaned = cleaned.replace(/\/+$/, "");
	if (bucketName) {
		const escaped = bucketName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
		cleaned = cleaned.replace(new RegExp(`^https?://${escaped}\\.`), "https://");
	}
	return cleaned;
}

function cleanS3Key(path: string): string {
	let key = normalizeSyncPath(path);
	while (key.startsWith("/")) {
		key = key.slice(1);
	}
	return key;
}

function emptyManifest(): SyncManifest {
	return {
		version: "4.0",
		deviceId: "",
		deviceName: "",
		lastSyncTime: 0,
		files: {},
		deleted: {},
	};
}

export interface SyncResult {
	uploaded: number;
	downloaded: number;
	deleted: number;
	localDeleted: number;
	localDeletedPaths: string[];  // 本地删除的路径列表，用于立碑
	orphanCleaned: number;
	failed: Array<{ path: string; error: string }>;
	conflicts: string[];
}

export class S3TransferManager {
	private client: S3Client;
	private bucket: string;
	private vault: Vault;
	private scanner: FileScanner;
	private deviceId: string;
	private deviceName: string;
	public isSyncing: boolean = false;
	private manifestETag: string | undefined;
	private manifestExists = false;

	// 观察者账本：同步过程中实时更新，同步完成后回写 main.ts
	public localManifest: Record<string, FileState> = {};

	constructor(vault: Vault, settings: S3BackupSettings) {
		const endpoint = cleanEndpoint(settings.endpoint, settings.bucketName);
		this.client = new S3Client({
			credentials: {
				accessKeyId: settings.accessKey.trim(),
				secretAccessKey: settings.secretKey.trim(),
			},
			endpoint: endpoint,
			region: settings.region || "us-east-1",
			forcePathStyle: false,
		});
		this.bucket = settings.bucketName;
		this.vault = vault;
		this.deviceId = settings.deviceId;
		this.deviceName = settings.deviceName;
		this.scanner = new FileScanner(vault.adapter, settings);
	}

	// ── 上传：二进制走 readBinary，文本走 read ──

	async uploadFile(path: string, content: Uint8Array, mtime: number, contentHash: string): Promise<string | undefined> {
		const key = cleanS3Key(path);
		const resp = await this.client.send(new PutObjectCommand({
			Bucket: this.bucket,
			Key: key,
			Body: content,
			Metadata: {
				"x-amz-meta-mtime": String(mtime),
				"x-amz-meta-content-sha256": contentHash,
			},
		}));
		return resp.ETag;
	}

	private async readLocalFile(path: string): Promise<Uint8Array> {
		if (isBinaryPath(path)) {
			const arrayBuffer = await this.vault.adapter.readBinary(path);
			return new Uint8Array(arrayBuffer);
		}
		const text = await this.vault.adapter.read(path);
		const encoder = new TextEncoder();
		return encoder.encode(text);
	}

	// ── 下载：二进制走 writeBinary，文本走 write ──

	private async downloadAndWriteFile(path: string): Promise<{ mtime: number | null; contentHash: string; remoteRevision?: string }> {
		const key = cleanS3Key(path);
		const resp = await this.client.send(new GetObjectCommand({
			Bucket: this.bucket,
			Key: key,
		}));

		const mtimeStr = resp.Metadata?.["x-amz-meta-mtime"];
		const mtime = mtimeStr ? parseInt(mtimeStr, 10) : null;
		const bytes = await resp.Body!.transformToByteArray();
		const contentHash = resp.Metadata?.["x-amz-meta-content-sha256"] ?? await sha256Hex(bytes);

		if (isBinaryPath(path)) {
			const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
			await this.vault.adapter.writeBinary(path, buffer);
		} else {
			const text = new TextDecoder("utf-8").decode(bytes);
			await this.vault.adapter.write(path, text);
		}

		return {mtime, contentHash, remoteRevision: resp.ETag};
	}

	async deleteFile(path: string): Promise<void> {
		const key = cleanS3Key(path);
		console.log("[S3 Sync] 删除云端文件：", key);
		await this.client.send(new DeleteObjectCommand({
			Bucket: this.bucket,
			Key: key,
		}));
	}

	async fetchCloudManifest(): Promise<SyncManifest> {
		try {
			const resp = await this.client.send(new GetObjectCommand({
				Bucket: this.bucket,
				Key: "manifest.json",
			}));
			this.manifestETag = resp.ETag;
			this.manifestExists = true;
			const body = await resp.Body!.transformToString("utf-8");
			const parsed = JSON.parse(body);

			parsed.version = "4.0";
			parsed.deviceName = parsed.deviceName ?? "";

			const migratedFiles: Record<string, FileState> = {};
			for (const [path, entry] of Object.entries(parsed.files ?? {}) as Array<[string, Record<string, unknown>]>) {
				migratedFiles[path] = createSyncedFileState(path, normalizeFileState(path, entry as Partial<FileState>, parsed.deviceId ?? ""));
			}
			parsed.files = migratedFiles;

			const migratedDeleted: Record<string, DeletedEntry> = {};
			for (const [path, val] of Object.entries(parsed.deleted ?? {})) {
				if (typeof val === "number") {
					migratedDeleted[path] = normalizeDeletedEntry(path, {mtime: val, deletedBy: ""}, parsed.deviceId ?? "");
				} else {
					migratedDeleted[path] = normalizeDeletedEntry(path, val as Partial<DeletedEntry>, parsed.deviceId ?? "");
				}
			}
			parsed.deleted = migratedDeleted;
			parsed.remoteRevision = this.manifestETag;

			console.log("[S3 Sync] 云端 manifest 已获取，文件数：", Object.keys(parsed.files).length, "删除记录：", Object.keys(parsed.deleted).length);
			return parsed as SyncManifest;
		} catch (err: unknown) {
			const errName = (err as { name?: string })?.name ?? "";
			const httpStatus = (err as { $metadata?: { httpStatusCode?: number } })?.$metadata?.httpStatusCode;
			if (httpStatus === 404 || errName === "NoSuchKey" || errName === "NotFound") {
				console.log("[S3 Sync] 云端无 manifest.json，返回空白初始结构");
				this.manifestETag = undefined;
				this.manifestExists = false;
			} else {
				console.warn("[S3 Sync] 获取云端 manifest 失败：", err);
			}
			return emptyManifest();
		}
	}

	async uploadManifest(manifest: SyncManifest): Promise<void> {
		console.log("[S3 Sync] 上传 manifest.json，文件数：", Object.keys(manifest.files).length, "删除记录：", Object.keys(manifest.deleted).length);
		const body = JSON.stringify({...manifest, remoteRevision: undefined}, null, "\t");
		const resp = await this.client.send(new PutObjectCommand({
			Bucket: this.bucket,
			Key: "manifest.json",
			Body: body,
			ContentType: "application/json",
			...(this.manifestETag ? {IfMatch: this.manifestETag} : this.manifestExists ? {} : {IfNoneMatch: "*"}),
		}));
		this.manifestETag = resp.ETag;
		this.manifestExists = true;
	}

	// ── 云端孤儿文件清理 ──

	async cleanOrphanFiles(cloudManifest: SyncManifest): Promise<number> {
		const manifestKeys = new Set(Object.keys(cloudManifest.files));
		manifestKeys.add("manifest.json");

		const allCloudKeys: string[] = [];
		const orphanKeys: string[] = [];

		try {
			let continuationToken: string | undefined = undefined;
			do {
				const resp: ListObjectsV2CommandOutput = await this.client.send(new ListObjectsV2Command({
					Bucket: this.bucket,
					ContinuationToken: continuationToken,
				}));

				const contents = resp.Contents;
				if (contents) {
					for (const obj of contents) {
						const objKey = obj.Key;
						if (objKey) {
							allCloudKeys.push(objKey);
							if (!manifestKeys.has(objKey)) {
								orphanKeys.push(objKey);
							}
						}
					}
				}

				continuationToken = resp.IsTruncated ? resp.NextContinuationToken : undefined;
			} while (continuationToken);
		} catch (err: unknown) {
			const msg = err instanceof Error ? err.message : String(err);
			console.warn("[S3 Sync] 列出云端对象失败，跳过孤儿清理：", msg);
			return 0;
		}

		console.log("[S3 Sync] 当前云端文件列表总数:", allCloudKeys.length, allCloudKeys);

		if (orphanKeys.length === 0) {
			console.log("[S3 Sync] 云端无孤儿文件，桶环境干净");
			return 0;
		}
		console.warn("[S3 Sync] 发现云端未同步(孤儿)文件:", orphanKeys);

		const deletedKeys: string[] = [];
		for (const key of orphanKeys) {
			try {
				await this.client.send(new DeleteObjectCommand({
					Bucket: this.bucket,
					Key: key,
				}));
				deletedKeys.push(key);
			} catch (err: unknown) {
				const msg = err instanceof Error ? err.message : String(err);
				console.warn("[S3 Sync] 清理孤儿文件失败：", key, msg);
			}
		}
		console.log("[S3 Sync] 成功清理孤儿文件:", deletedKeys);

		return deletedKeys.length;
	}

	// ── 并发池 ──

	private async runConcurrent(
		paths: string[],
		mode: "upload" | "download" | "delete",
		localFiles: Record<string, FileState>,
		cloudFiles: Record<string, FileState>,
		totalCount: number,
		doneCount: { value: number },
		result: SyncResult,
	): Promise<void> {
		const inFlight: Set<Promise<void>> = new Set();
		let nextIndex = 0;

		const executeOne = async (itemPath: string): Promise<void> => {
			let lastError = "";
			for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
				try {
					if (mode === "upload") {
						const byteContent = await this.readLocalFile(itemPath);
						const localEntry = normalizeFileState(itemPath, localFiles[itemPath] ?? {}, this.deviceId);
						const cloudEntry = cloudFiles[itemPath] ? normalizeFileState(itemPath, cloudFiles[itemPath], this.deviceId) : undefined;
						const contentHash = localEntry.contentHash || await sha256Hex(byteContent);
						const remoteRevision = await this.uploadFile(itemPath, byteContent, localEntry.mtime || Date.now(), contentHash);
						const nextVersion = (cloudEntry?.version ?? 0) + 1;

						this.localManifest[itemPath] = createSyncedFileState(itemPath, {
							...localEntry,
							fileId: localEntry.fileId || cloudEntry?.fileId || itemPath,
							version: nextVersion,
							baseVersion: nextVersion,
							contentHash,
							parentHash: contentHash,
							lastModifiedBy: this.deviceId,
							remoteRevision,
						}, remoteRevision);

						result.uploaded++;
					} else if (mode === "download") {
						const written = await this.downloadAndWriteFile(itemPath);

						const cloudEntry = cloudFiles[itemPath];
						if (cloudEntry) {
							const normalizedCloud = normalizeFileState(itemPath, cloudEntry, this.deviceId);
							const cloudHash = isTrustedContentHash(normalizedCloud.contentHash)
								? normalizedCloud.contentHash
								: written.contentHash;
							this.localManifest[itemPath] = createSyncedFileState(itemPath, {
								...normalizedCloud,
								contentHash: cloudHash,
								mtime: written.mtime ?? normalizedCloud.mtime,
								remoteRevision: written.remoteRevision ?? normalizedCloud.remoteRevision,
							}, written.remoteRevision);
						}

						result.downloaded++;
					} else {
						await this.deleteFile(itemPath);
						delete this.localManifest[itemPath];
						result.deleted++;
					}
					lastError = "";
					break;
				} catch (err: unknown) {
					lastError = err instanceof Error ? err.message : String(err);
					console.warn(`[S3 Sync] ${mode}失败 (尝试 ${attempt}/${MAX_RETRIES})：${itemPath} — ${lastError}`);
					if (attempt < MAX_RETRIES) {
						await new Promise<void>((r) => setTimeout(r, RETRY_DELAY_MS));
					}
				}
			}

			if (lastError) {
				result.failed.push({path: itemPath, error: lastError});
			}

			doneCount.value++;
			const pct = Math.round((doneCount.value / totalCount) * 100);
			const modeLabel = mode === "upload" ? "上传" : mode === "download" ? "下载" : "删除";
			console.log(`[S3 Sync] ${modeLabel}完成 (${doneCount.value}/${totalCount} ${pct}%)：${itemPath}`);
			new Notice(`${modeLabel} (${doneCount.value}/${totalCount}) ${itemPath}`);
		};

		while (nextIndex < paths.length) {
			while (inFlight.size < MAX_CONCURRENCY && nextIndex < paths.length) {
				const currentPath = paths[nextIndex];
				nextIndex++;
				if (currentPath == null) continue;

				const task = executeOne(currentPath);
				inFlight.add(task);
				task.then(
					() => { inFlight.delete(task); },
					() => { inFlight.delete(task); },
				);
			}

			if (inFlight.size > 0) {
				await Promise.race(inFlight);
			}
		}

		await Promise.all(inFlight);
	}

	// ── 处理同步队列 ──

	async processQueues(
		delta: SyncDelta,
		localFiles: Record<string, FileState>,
		cloudFiles: Record<string, FileState>,
		deviceId: string,
		deviceName: string,
		cloudManifest: SyncManifest,
	): Promise<SyncResult> {
		const result: SyncResult = {
			uploaded: 0,
			downloaded: 0,
			deleted: 0,
			localDeleted: 0, localDeletedPaths: [],
			orphanCleaned: 0,
			failed: [],
			conflicts: delta.conflictQueue,
		};
		const uploadPaths = delta.uploadQueue;
		const downloadPaths = delta.downloadQueue;
		const deletePaths = delta.deleteQueue;
		const localDeletePaths = delta.localDeleteQueue;
		const totalCount = uploadPaths.length + downloadPaths.length + deletePaths.length + localDeletePaths.length;
		const doneCount = {value: 0};

		if (totalCount === 0) {
			console.log("[S3 Sync] 无需传输的文件，跳过队列");
		}

		// ── 上传 ──
		if (uploadPaths.length > 0) {
			console.log(`[S3 Sync] 开始上传队列，共 ${uploadPaths.length} 个文件`);
			await this.runConcurrent(uploadPaths, "upload", localFiles, cloudFiles, totalCount, doneCount, result);
		}

		// ── 下载 ──
		if (downloadPaths.length > 0) {
			console.log(`[S3 Sync] 开始下载队列，共 ${downloadPaths.length} 个文件`);
			await this.runConcurrent(downloadPaths, "download", localFiles, cloudFiles, totalCount, doneCount, result);
		}

		// ── 云端删除 ──
		if (deletePaths.length > 0) {
			console.log(`[S3 Sync] 开始云端删除队列，共 ${deletePaths.length} 个文件`);
			await this.runConcurrent(deletePaths, "delete", localFiles, cloudFiles, totalCount, doneCount, result);
		}

		// ── 本地删除 ──
		if (localDeletePaths.length > 0) {
			console.log(`[S3 Sync] 开始本地删除队列，共 ${localDeletePaths.length} 个文件`);
			for (const localPath of localDeletePaths) {
				try {
					if (await this.vault.adapter.exists(localPath)) {
						await this.vault.adapter.remove(localPath);
						result.localDeleted++;
						result.localDeletedPaths.push(localPath);
						console.log("[S3 Sync] 已删除本地文件：", localPath);
					}
					delete this.localManifest[localPath];
				} catch (err: unknown) {
					const msg = err instanceof Error ? err.message : String(err);
					result.failed.push({path: localPath, error: `本地删除失败: ${msg}`});
				}
			}
		}

		// ── 上传最新 manifest（必须执行）──
		try {
			const now = Date.now();
			const failedPaths = new Set(
				result.failed
					.map(item => item.path)
					.filter(path => path !== "manifest.json"),
			);
			const successfulUploadPaths = uploadPaths.filter(path => !failedPaths.has(path));
			const successfulDownloadPaths = downloadPaths.filter(path => !failedPaths.has(path));
			const successfulDeletePaths = deletePaths.filter(path => !failedPaths.has(path));

			for (const path of new Set([...failedPaths, ...delta.conflictQueue])) {
				const cloudEntry = cloudFiles[path];
				if (cloudEntry) {
					this.localManifest[path] = createSyncedFileState(path, normalizeFileState(path, cloudEntry, deviceId));
				} else {
					delete this.localManifest[path];
				}
			}

			// 合并删除记录。墓碑长期保留，避免长期离线设备看不到删除历史后复活旧文件。
			const mergedDeleted: Record<string, DeletedEntry> = {};
			for (const [path, entry] of Object.entries(cloudManifest.deleted ?? {})) {
				mergedDeleted[path] = normalizeDeletedEntry(path, entry, deviceId);
			}
			for (const path of successfulDeletePaths) {
				const cloudEntry = cloudFiles[path] ? normalizeFileState(path, cloudFiles[path], deviceId) : undefined;
				const localEntry = localFiles[path] ? normalizeFileState(path, localFiles[path], deviceId) : undefined;
				const baseVersion = cloudEntry?.version ?? localEntry?.baseVersion ?? 0;
				mergedDeleted[path] = createDeletedEntry(
					path,
					deviceId,
					baseVersion,
					cloudEntry?.fileId ?? localEntry?.fileId ?? path,
					cloudEntry?.contentHash ?? localEntry?.contentHash ?? "",
					cloudEntry?.remoteRevision ?? localEntry?.remoteRevision,
				);
			}
			for (const path of successfulUploadPaths) {
				delete mergedDeleted[path];
			}
			for (const path of successfulDownloadPaths) {
				delete mergedDeleted[path];
			}

			const newManifest: SyncManifest = {
				version: "4.0",
				deviceId,
				deviceName,
				lastSyncTime: now,
				files: this.localManifest,
				deleted: mergedDeleted,
			};
			await this.uploadManifest(newManifest);
			console.log("[S3 Sync] manifest.json 已上传");
		} catch (err: unknown) {
			const msg = err instanceof Error ? err.message : String(err);
			console.error("[S3 Sync] manifest 上传失败：", msg);
			result.failed.push({path: "manifest.json", error: `manifest上传失败: ${msg}`});
		}

		return result;
	}

	// ── 一键同步入口 ──

	async fullSync(
		deviceId: string,
		localLastSyncTime: number,
		onProgress?: (done: number, total: number) => void,
		localTombstones: Record<string, DeletedEntry> = {},
		localLedger: Record<string, FileState> = {},
	): Promise<SyncResult> {
		if (this.isSyncing) {
			console.log("[S3 Sync] 当前已有同步任务正在进行，跳过本次触发");
			return {uploaded: 0, downloaded: 0, deleted: 0, localDeleted: 0, localDeletedPaths: [], orphanCleaned: 0, failed: [], conflicts: []};
		}
		this.isSyncing = true;
		try {
			console.log("[S3 Sync] 开始执行增量同步...");

			// 扫描物理文件系统
			const diskFiles = await this.scanner.scanAll();
			console.log("[S3 Sync] 磁盘文件扫描完成，文件数：", Object.keys(diskFiles).length);

			// 合并：磁盘真实内容哈希 + 本地版本账本 → 最终 localFiles。
			const localFiles: Record<string, FileState> = {};
			for (const [path, diskEntry] of Object.entries(diskFiles)) {
				const ledgerEntry = localLedger[path];
				localFiles[path] = mergeDiskWithLedger(path, diskEntry, ledgerEntry, deviceId);
			}
			// 账本中有但磁盘已不存在的文件 → 不加入 localFiles（已删除）

			// 初始化 localManifest 快照
			this.localManifest = {...localFiles};

			const cloudManifest = await this.fetchCloudManifest();
			const orphanCleaned = await this.cleanOrphanFiles(cloudManifest);
			const delta = computeSyncDelta(localFiles, cloudManifest, deviceId, localTombstones, localLedger);

			console.log("[S3 Sync] 待上传队列:", delta.uploadQueue);
			console.log("[S3 Sync] 待下载队列:", delta.downloadQueue);
			console.log("[S3 Sync] 云端删除队列:", delta.deleteQueue);
			console.log("[S3 Sync] 本地删除队列:", delta.localDeleteQueue);
			console.log("[S3 Sync] 冲突队列:", delta.conflictQueue);
			console.log("[S3 Sync] 哈希缝合:", delta.hashStitched);

			// ── 哈希缝合：同名同 Hash 文件无缝编入本地账本 ──
			for (const path of delta.hashStitched) {
				const cloudEntry = cloudManifest?.files?.[path];
				if (cloudEntry) {
					this.localManifest[path] = createSyncedFileState(path, normalizeFileState(path, cloudEntry, deviceId));
				}
			}
			if (delta.hashStitched.length > 0) {
				console.log("[S3 Sync] 哈希缝合完成：", delta.hashStitched.length, "个文件无需传输，已编入账本");
			}

			const cloudFiles = cloudManifest?.files ?? {};
			const syncResult = await this.processQueues(delta, localFiles, cloudFiles, deviceId, this.deviceName, cloudManifest);
			syncResult.orphanCleaned = orphanCleaned;

			console.log("[S3 Sync] 同步完成，已生成最新 manifest.json");
			return syncResult;
		} finally {
			this.isSyncing = false;
		}
	}

	// ── 快速合并提交 ──

	async quickSync(
		deviceId: string,
		localLastSyncTime: number,
		recentMs: number,
		localTombstones: Record<string, DeletedEntry> = {},
		localLedger: Record<string, FileState> = {},
	): Promise<SyncResult> {
		if (this.isSyncing) {
			console.log("[S3 Sync] 当前已有同步任务正在进行，跳过本次触发");
			return {uploaded: 0, downloaded: 0, deleted: 0, localDeleted: 0, localDeletedPaths: [], orphanCleaned: 0, failed: [], conflicts: []};
		}
		this.isSyncing = true;
		try {
			console.log("[S3 Sync] 开始快速同步，时间窗口：", recentMs, "ms");
			const diskFiles = await this.scanner.scanAll();

			// 合并磁盘真实内容哈希 + 本地版本账本
			const localFiles: Record<string, FileState> = {};
			for (const [path, diskEntry] of Object.entries(diskFiles)) {
				const ledgerEntry = localLedger[path];
				localFiles[path] = mergeDiskWithLedger(path, diskEntry, ledgerEntry, deviceId);
			}

			this.localManifest = {...localFiles};

			const cloudManifest = await this.fetchCloudManifest();
			const delta = computeSyncDelta(localFiles, cloudManifest, deviceId, localTombstones, localLedger);

			const cloudFiles = cloudManifest?.files ?? {};
			const recentDelta: SyncDelta = {
				uploadQueue: delta.uploadQueue,
				downloadQueue: delta.downloadQueue,
				deleteQueue: delta.deleteQueue,
				localDeleteQueue: delta.localDeleteQueue,
				conflictQueue: delta.conflictQueue,
				hashStitched: delta.hashStitched,
			};

			const totalActions = recentDelta.uploadQueue.length + recentDelta.downloadQueue.length + recentDelta.deleteQueue.length + recentDelta.localDeleteQueue.length;
			if (totalActions === 0 && recentDelta.conflictQueue.length === 0) {
				console.log("[S3 Sync] 无近期变更，跳过");
				return {uploaded: 0, downloaded: 0, deleted: 0, localDeleted: 0, localDeletedPaths: [], orphanCleaned: 0, failed: [], conflicts: []};
			}

			console.log("[S3 Sync] 近期变更：上传", recentDelta.uploadQueue.length, "下载", recentDelta.downloadQueue.length, "云端删除", recentDelta.deleteQueue.length, "本地删除", recentDelta.localDeleteQueue.length);

			return this.processQueues(recentDelta, localFiles, cloudFiles, deviceId, this.deviceName, cloudManifest);
		} finally {
			this.isSyncing = false;
		}
	}
}
