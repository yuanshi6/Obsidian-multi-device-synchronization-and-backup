import {DeleteObjectCommand, GetObjectCommand, GetObjectCommandOutput, ListObjectsV2Command, ListObjectsV2CommandOutput, PutObjectCommand, S3Client} from "@aws-sdk/client-s3";
import {Notice, Platform, Vault} from "obsidian";
import {S3BackupSettings} from "./settings";
import {
	computeSyncDelta,
	createDeletedEntry,
	createSyncedFileState,
	DeletedEntry,
	FileState,
	FileScanner,
	isLocalDirty,
	isTrustedContentHash,
	mergeDiskWithLedger,
	normalizeDeletedEntry,
	normalizeFileState,
	normalizeStoragePrefix,
	normalizeSyncPath,
	sha256Hex,
	SyncDelta,
	SyncManifest,
} from "./scanner";

const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 2000;
const DEFAULT_MAX_CONCURRENCY = Platform.isMobile ? 1 : 3;

export interface TransferWriteHooks {
	beginPathWrite?: (path: string) => void;
	endPathWrite?: (path: string, contentHash?: string) => void;
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
		version: "5.0",
		deviceId: "",
		deviceName: "",
		lastSyncTime: 0,
		files: {},
		deleted: {},
	};
}

function isNotFoundError(err: unknown): boolean {
	const errName = (err as { name?: string })?.name ?? "";
	const errMessage = (err as { message?: string })?.message ?? "";
	const httpStatus = (err as { $metadata?: { httpStatusCode?: number } })?.$metadata?.httpStatusCode;
	return httpStatus === 404 || errName === "NoSuchKey" || errName === "NotFound" || errMessage.includes("NoSuchKey");
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
	private maxConcurrency = DEFAULT_MAX_CONCURRENCY;

	public storagePrefix: string = "_obsidian-sync/";
	public enableConditionalWrite: boolean = true;
	public enableOrphanCleanup: boolean = false;
	private writeHooks: TransferWriteHooks;

	// 观察者账本：同步过程中实时更新，同步完成后回写 main.ts
	public localManifest: Record<string, FileState> = {};

	constructor(vault: Vault, settings: S3BackupSettings, writeHooks: TransferWriteHooks = {}) {
		const endpoint = cleanEndpoint(settings.endpoint, settings.bucketName);
		this.client = new S3Client({
			credentials: {
				accessKeyId: settings.accessKey.trim(),
				secretAccessKey: settings.secretKey.trim(),
			},
			endpoint: endpoint,
			region: settings.region || "us-east-1",
			forcePathStyle: settings.forcePathStyle ?? false,
		});
		this.bucket = settings.bucketName;
		this.vault = vault;
		this.deviceId = settings.deviceId;
		this.deviceName = settings.deviceName;
		
		this.storagePrefix = normalizeStoragePrefix(settings.storagePrefix);
		this.enableConditionalWrite = settings.enableConditionalWrite ?? true;
		this.enableOrphanCleanup = settings.enableOrphanCleanup ?? false;
		this.writeHooks = writeHooks;

		this.scanner = new FileScanner(vault.adapter, settings);
	}

	// ── 上传：内容寻址存储 ──

	async uploadFile(path: string, content: Uint8Array, mtime: number, contentHash: string): Promise<{etag: string | undefined, objectKey: string}> {
		const objectKey = `${this.storagePrefix}objects/${contentHash.slice(0, 2)}/${contentHash}`;
		const resp = await this.client.send(new PutObjectCommand({
			Bucket: this.bucket,
			Key: objectKey,
			Body: content,
			Metadata: {
				"mtime": String(mtime),
				"content-sha256": contentHash,
				"original-path-encoded": encodeURIComponent(normalizeSyncPath(path)),
			},
		}));
		return {etag: resp.ETag, objectKey};
	}

	private async readLocalFile(path: string): Promise<Uint8Array> {
		const arrayBuffer = await this.vault.adapter.readBinary(path);
		return new Uint8Array(arrayBuffer);
	}

	private async ensureParentFolder(filePath: string): Promise<void> {
		const parts = filePath.split("/");
		parts.pop();
		if (parts.length === 0) return;

		let current = "";
		for (const part of parts) {
			current = current ? `${current}/${part}` : part;
			if (!(await this.vault.adapter.exists(current))) {
				try {
					await this.vault.adapter.mkdir(current);
				} catch (err) {
					console.warn("[S3 Sync] 无法创建目录：", current, err);
				}
			}
		}
	}

	private async withSuppressedWrite<T>(path: string, contentHash: string | undefined, fn: () => Promise<T>): Promise<T> {
		this.writeHooks.beginPathWrite?.(path);
		let completed = false;
		try {
			const result = await fn();
			completed = true;
			return result;
		} finally {
			this.writeHooks.endPathWrite?.(path, completed ? contentHash : undefined);
		}
	}

	private recordConflict(result: SyncResult, path: string, reason: string): void {
		if (!result.conflicts.includes(path)) {
			result.conflicts.push(path);
		}
		console.warn("[S3 Sync] 检测到并发本地修改，转入冲突处理：", path, reason);
	}

	private async hasLocalContentChangedSinceScan(path: string, baseline: FileState | undefined, missingIsChange: boolean): Promise<boolean> {
		if (!baseline) return false;
		const expectedHash = normalizeFileState(path, baseline, this.deviceId).contentHash;
		if (!expectedHash) return false;

		const exists = await this.vault.adapter.exists(path);
		if (!exists) return missingIsChange;

		const bytes = new Uint8Array(await this.vault.adapter.readBinary(path));
		const currentHash = await sha256Hex(bytes);
		return currentHash !== expectedHash;
	}

	async downloadAndWriteFile(path: string, objectKey?: string, writePath?: string, expectedHash?: string): Promise<{ mtime: number | null; contentHash: string; remoteRevision?: string; objectKey?: string }> {
		const legacyKey = cleanS3Key(path);
		const contentAddressedKey = expectedHash && isTrustedContentHash(expectedHash)
			? `${this.storagePrefix}objects/${expectedHash.slice(0, 2)}/${expectedHash}`
			: undefined;
		const candidateKeys = Array.from(new Set([
			objectKey,
			contentAddressedKey,
			legacyKey,
		].filter((key): key is string => typeof key === "string" && key.length > 0)));
		const destPath = writePath || path;
		let resp: GetObjectCommandOutput | undefined;
		let usedKey: string | undefined;
		let lastError: unknown;

		for (const key of candidateKeys) {
			try {
				resp = await this.client.send(new GetObjectCommand({
					Bucket: this.bucket,
					Key: key,
				}));
				usedKey = key;
				break;
			} catch (err) {
				lastError = err;
				if (key !== candidateKeys[candidateKeys.length - 1] && isNotFoundError(err)) {
					console.warn("[S3 Sync] 下载对象不存在，尝试下一个候选 key：", key);
					continue;
				}
				throw err;
			}
		}

		if (!resp || !usedKey) {
			throw lastError instanceof Error ? lastError : new Error(`下载失败: ${path}`);
		}

		const mtimeStr = resp.Metadata?.["x-amz-meta-mtime"] ?? resp.Metadata?.["mtime"];
		const mtime = mtimeStr ? parseInt(mtimeStr, 10) : null;
		const bytes = await resp.Body!.transformToByteArray();

		// 始终计算实际哈希并与预期哈希对比，防止对象被篡改或损坏
		const downloadedHash = await sha256Hex(bytes);

		if (expectedHash && downloadedHash !== expectedHash) {
			console.error("[S3 Sync] 下载文件内容哈希与 manifest 预期不匹配！文件：", path,
				"预期哈希：", expectedHash, "实际下载哈希：", downloadedHash);
			throw new Error(`内容哈希校验失败: 预期 ${expectedHash}，实际 ${downloadedHash}`);
		}

		await this.withSuppressedWrite(destPath, downloadedHash, async () => {
			await this.ensureParentFolder(destPath);
			const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
			await this.vault.adapter.writeBinary(destPath, buffer);
		});

		let finalObjectKey = (usedKey === objectKey || usedKey === contentAddressedKey) ? usedKey : undefined;
		if (!finalObjectKey && isTrustedContentHash(downloadedHash)) {
			const migrated = await this.uploadFile(path, bytes, mtime ?? Date.now(), downloadedHash);
			finalObjectKey = migrated.objectKey;
			console.log("[S3 Sync] 已将旧路径对象迁移到内容寻址对象：", path, finalObjectKey);
			return {mtime, contentHash: downloadedHash, remoteRevision: migrated.etag ?? resp.ETag, objectKey: finalObjectKey};
		}

		return {mtime, contentHash: downloadedHash, remoteRevision: resp.ETag, objectKey: finalObjectKey};
	}

	async deleteFile(path: string): Promise<void> {
		console.log("[S3 Sync] 标记云端删除（内容寻址无需删除对象）：", path);
	}

	async fetchCloudManifest(): Promise<SyncManifest> {
		try {
			const resp = await this.client.send(new GetObjectCommand({
				Bucket: this.bucket,
				Key: `${this.storagePrefix}manifest.json`,
			}));
			this.manifestETag = resp.ETag;
			this.manifestExists = true;
			const body = await resp.Body!.transformToString("utf-8");
			const parsed = JSON.parse(body);

			parsed.version = "5.0";
			parsed.deviceName = parsed.deviceName ?? "";

			const migratedFiles: Record<string, FileState> = {};
			for (const [path, entry] of Object.entries(parsed.files ?? {}) as Array<[string, Record<string, unknown>]>) {
				const normalized = normalizeFileState(path, entry as Partial<FileState>, parsed.deviceId ?? "");
				const synced = createSyncedFileState(path, normalized);
				// v4.0 迁移：从 contentHash 计算 objectKey
				if (!synced.objectKey && isTrustedContentHash(synced.contentHash)) {
					synced.objectKey = `${this.storagePrefix}objects/${synced.contentHash.slice(0, 2)}/${synced.contentHash}`;
				}
				migratedFiles[path] = synced;
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
			if (isNotFoundError(err)) {
				console.log("[S3 Sync] 云端无 manifest.json，返回空白初始结构");
				this.manifestETag = undefined;
				this.manifestExists = false;
				return emptyManifest();
			} else {
				console.error("[S3 Sync] 获取云端 manifest 失败（将中止同步，防止数据覆盖与删除）：", err);
				throw err;
			}
		}
	}

	async uploadManifest(manifest: SyncManifest): Promise<void> {
		console.log("[S3 Sync] 上传 manifest.json，文件数：", Object.keys(manifest.files).length, "删除记录：", Object.keys(manifest.deleted).length);
		const body = JSON.stringify({...manifest, remoteRevision: undefined}, null, "\t");
		const resp = await this.client.send(new PutObjectCommand({
			Bucket: this.bucket,
			Key: `${this.storagePrefix}manifest.json`,
			Body: body,
			ContentType: "application/json",
			...(this.enableConditionalWrite ? (this.manifestETag ? {IfMatch: this.manifestETag} : this.manifestExists ? {} : {IfNoneMatch: "*"}) : {}),
		}));
		this.manifestETag = resp.ETag;
		this.manifestExists = true;
	}

	// ── 云端孤儿文件清理 ──

	async cleanOrphanFiles(cloudManifest: SyncManifest): Promise<number> {
		if (!this.enableOrphanCleanup) {
			console.warn("[S3 Sync] 孤儿文件清理未启用，跳过清理");
			return 0;
		}

		// 收集 manifest 中所有对象 key
		const manifestKeys = new Set<string>();
		for (const entry of Object.values(cloudManifest.files)) {
			const normalized = normalizeFileState("", entry, this.deviceId);
			if (normalized.objectKey) manifestKeys.add(normalized.objectKey);
		}
		manifestKeys.add(`${this.storagePrefix}manifest.json`);

		const allCloudKeys: string[] = [];
		const orphanKeys: string[] = [];

		try {
			let continuationToken: string | undefined = undefined;
			do {
				const resp: ListObjectsV2CommandOutput = await this.client.send(new ListObjectsV2Command({
					Bucket: this.bucket,
					Prefix: `${this.storagePrefix}objects/`,
					ContinuationToken: continuationToken,
				}));

				const contents = resp.Contents;
				if (contents) {
					for (const obj of contents) {
						const objKey = obj.Key;
						if (objKey) {
							allCloudKeys.push(objKey);
							
							const lastModified = obj.LastModified;
							const isOldEnough = lastModified && (Date.now() - lastModified.getTime() > 24 * 60 * 60 * 1000);
							if (!manifestKeys.has(objKey) && isOldEnough) {
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
			console.log("[S3 Sync] 云端无符合条件的孤儿文件（未引用且超过24小时）");
			return 0;
		}
		console.warn("[S3 Sync] 发现待清理的云端孤儿文件:", orphanKeys);

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
		onProgress?: (done: number, total: number, mode: "upload" | "download" | "delete") => void,
		showFileNotices = true,
		localTombstones?: Record<string, DeletedEntry>
	): Promise<void> {
		const inFlight: Set<Promise<void>> = new Set();
		let nextIndex = 0;

		const executeOne = async (itemPath: string): Promise<void> => {
			let lastError = "";
			for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
				try {
					if (mode === "upload") {
						if (!(await this.vault.adapter.exists(itemPath))) {
							if (localTombstones && localTombstones[itemPath]) {
								console.warn(`[S3 Sync] 上传前发现本地文件已不存在，且存在墓碑（可能已被重命名/删除），跳过上传：${itemPath}`);
								lastError = "";
								break;
							}
							throw new Error("ENOENT: no such file or directory");
						}
						const byteContent = await this.readLocalFile(itemPath);
						const localEntry = normalizeFileState(itemPath, localFiles[itemPath] ?? {}, this.deviceId);
						const cloudEntry = cloudFiles[itemPath] ? normalizeFileState(itemPath, cloudFiles[itemPath], this.deviceId) : undefined;
						const contentHash = await sha256Hex(byteContent);
						if (localEntry.contentHash && localEntry.contentHash !== contentHash) {
							console.warn("[S3 Sync] 上传前文件内容已变化，使用实际读取内容重新计算对象 hash：", itemPath);
						}
						const {etag: remoteRevision, objectKey} = await this.uploadFile(itemPath, byteContent, localEntry.mtime || Date.now(), contentHash);
						const nextVersion = cloudEntry
							? cloudEntry.version + 1
							: isLocalDirty(localEntry)
								? Math.max(localEntry.version, localEntry.baseVersion) + 1
								: Math.max(localEntry.version, 1);

						this.localManifest[itemPath] = {
							...createSyncedFileState(itemPath, {
								...localEntry,
								fileId: localEntry.fileId || cloudEntry?.fileId || itemPath,
								version: nextVersion,
								baseVersion: nextVersion,
								contentHash,
								parentHash: contentHash,
								lastModifiedBy: this.deviceId,
								remoteRevision,
							}, remoteRevision),
							objectKey,
						};

						result.uploaded++;
					} else if (mode === "download") {
						if (await this.hasLocalContentChangedSinceScan(itemPath, localFiles[itemPath], true)) {
							this.recordConflict(result, itemPath, "下载前本地内容已变化，跳过覆盖");
							break;
						}
						const cloudEntry = cloudFiles[itemPath];
						const normalizedCloud = cloudEntry ? normalizeFileState(itemPath, cloudEntry, this.deviceId) : undefined;
						const written = await this.downloadAndWriteFile(
							itemPath,
							normalizedCloud?.objectKey,
							undefined,
							normalizedCloud?.contentHash
						);

						if (cloudEntry && normalizedCloud) {
							const cloudHash = isTrustedContentHash(normalizedCloud.contentHash)
								? normalizedCloud.contentHash
								: written.contentHash;
							this.localManifest[itemPath] = createSyncedFileState(itemPath, {
								...normalizedCloud,
								contentHash: cloudHash,
								mtime: written.mtime ?? normalizedCloud.mtime,
								remoteRevision: written.remoteRevision ?? normalizedCloud.remoteRevision,
								objectKey: written.objectKey ?? normalizedCloud.objectKey,
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
			if (showFileNotices) {
				new Notice(`${modeLabel} (${doneCount.value}/${totalCount}) ${itemPath}`);
			}
			if (onProgress) onProgress(doneCount.value, totalCount, mode);
		};

		while (nextIndex < paths.length) {
			while (inFlight.size < this.maxConcurrency && nextIndex < paths.length) {
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
		onProgress?: (done: number, total: number, mode: "upload" | "download" | "delete") => void,
		localTombstones: Record<string, DeletedEntry> = {},
		showFileNotices = true,
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
			await this.runConcurrent(uploadPaths, "upload", localFiles, cloudFiles, totalCount, doneCount, result, onProgress, showFileNotices, localTombstones);
		}

		// ── 下载 ──
		if (downloadPaths.length > 0) {
			console.log(`[S3 Sync] 开始下载队列，共 ${downloadPaths.length} 个文件`);
			await this.runConcurrent(downloadPaths, "download", localFiles, cloudFiles, totalCount, doneCount, result, onProgress, showFileNotices);
		}

		// ── 云端删除 ──
		if (deletePaths.length > 0) {
			console.log(`[S3 Sync] 开始云端删除队列，共 ${deletePaths.length} 个文件`);
			await this.runConcurrent(deletePaths, "delete", localFiles, cloudFiles, totalCount, doneCount, result, onProgress, showFileNotices);
		}

		// ── 本地删除 ──
		if (localDeletePaths.length > 0) {
			console.log(`[S3 Sync] 开始本地删除队列，共 ${localDeletePaths.length} 个文件`);
			for (const localPath of localDeletePaths) {
				try {
					if (await this.hasLocalContentChangedSinceScan(localPath, localFiles[localPath], false)) {
						this.recordConflict(result, localPath, "本地删除前内容已变化，跳过删除");
						continue;
					}
					if (await this.vault.adapter.exists(localPath)) {
						await this.withSuppressedWrite(localPath, undefined, () => this.vault.adapter.remove(localPath));
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

		// ── 上传最新 manifest ──
		if (result.failed.length > 0) {
			console.warn("[S3 Sync] 存在失败文件，跳过 manifest 提交，等待下次重试");
			result.failed.push({path: "manifest.json", error: "存在文件失败，跳过 manifest 提交"});
			return result;
		}

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
			const publishTombstonePaths = (delta.publishTombstoneQueue ?? []).filter(path => !failedPaths.has(path));

			// 仅回滚失败的路径为同步前的账本记录 (冲突路径 delta.conflictQueue 保持 dirty 状态，排除在此 loop 之外)
			for (const path of failedPaths) {
				const originalEntry = localFiles[path];
				if (originalEntry) {
					this.localManifest[path] = originalEntry;
				} else {
					delete this.localManifest[path];
				}
			}

			// 合并删除记录。
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
			for (const path of publishTombstonePaths) {
				const tombstone = localTombstones[path];
				if (tombstone) {
					mergedDeleted[path] = normalizeDeletedEntry(path, tombstone, deviceId);
				}
			}
			for (const path of successfulUploadPaths) {
				delete mergedDeleted[path];
			}
			for (const path of successfulDownloadPaths) {
				delete mergedDeleted[path];
			}

			const manifestFiles: Record<string, FileState> = {...this.localManifest};
			for (const path of publishTombstonePaths) {
				delete manifestFiles[path];
			}
			const allConflictPaths = new Set([...delta.conflictQueue, ...result.conflicts]);
			for (const path of allConflictPaths) {
				const cloudEntry = cloudFiles[path];
				if (cloudEntry) {
					const normalizedCloud = normalizeFileState(path, cloudEntry, deviceId);
					manifestFiles[path] = createSyncedFileState(
						path,
						normalizedCloud,
						normalizedCloud.remoteRevision,
					);
				} else {
					delete manifestFiles[path];
				}
			}

			const newManifest: SyncManifest = {
				version: "5.0",
				deviceId,
				deviceName,
				lastSyncTime: now,
				files: manifestFiles,
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
		onProgress?: (done: number, total: number, mode: "upload" | "download" | "delete") => void,
		localTombstones: Record<string, DeletedEntry> = {},
		localLedger: Record<string, FileState> = {},
		showFileNotices = true,
		ignoredPaths: Set<string> = new Set(),
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

			// 初始化 localManifest 快照
			this.localManifest = {...localFiles};

			let cloudManifest: SyncManifest;
			try {
				cloudManifest = await this.fetchCloudManifest();
			} catch (err) {
				console.error("[S3 Sync] 无法获取云端 manifest，中止同步：", err);
				throw err;
			}
			
			const delta = computeSyncDelta(localFiles, cloudManifest, deviceId, localTombstones, localLedger);
			
			if (ignoredPaths.size > 0) {
				delta.uploadQueue = delta.uploadQueue.filter(p => !ignoredPaths.has(p));
				delta.downloadQueue = delta.downloadQueue.filter(p => !ignoredPaths.has(p));
				delta.deleteQueue = delta.deleteQueue.filter(p => !ignoredPaths.has(p));
				delta.localDeleteQueue = delta.localDeleteQueue.filter(p => !ignoredPaths.has(p));
			}

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
			const syncResult = await this.processQueues(delta, localFiles, cloudFiles, deviceId, this.deviceName, cloudManifest, onProgress, localTombstones, showFileNotices);

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
		pendingPaths: string[] = [],
		showFileNotices = true,
	): Promise<SyncResult> {
		if (this.isSyncing) {
			console.log("[S3 Sync] 当前已有同步任务正在进行，跳过本次快速同步");
			return {uploaded: 0, downloaded: 0, deleted: 0, localDeleted: 0, localDeletedPaths: [], orphanCleaned: 0, failed: [], conflicts: []};
		}
		this.isSyncing = true;
		try {
			console.log("[S3 Sync] 开始快速同步，处理中路径数：", pendingPaths.length, "墓碑数：", Object.keys(localTombstones).length);

			if (pendingPaths.length === 0) {
				console.log("[S3 Sync] 无待同步路径，快速同步结束");
				return {uploaded: 0, downloaded: 0, deleted: 0, localDeleted: 0, localDeletedPaths: [], orphanCleaned: 0, failed: [], conflicts: []};
			}

			const pathsToScan = new Set(pendingPaths.filter(path => !localTombstones[path]));
			const diskFiles = await this.scanner.scanPaths([...pathsToScan]);

			// 合并磁盘真实状态和之前的本地账本状态
			const localFiles: Record<string, FileState> = {};
			for (const [path, entry] of Object.entries(localLedger)) {
				localFiles[path] = normalizeFileState(path, entry, deviceId);
			}
			for (const [path, diskEntry] of Object.entries(diskFiles)) {
				const ledgerEntry = localLedger[path];
				localFiles[path] = mergeDiskWithLedger(path, diskEntry, ledgerEntry, deviceId);
			}

			this.localManifest = {...localFiles};

			let cloudManifest: SyncManifest;
			try {
				cloudManifest = await this.fetchCloudManifest();
			} catch (err) {
				console.error("[S3 Sync] 无法获取云端 manifest，中止快速同步：", err);
				throw err;
			}
			const delta = computeSyncDelta(localFiles, cloudManifest, deviceId, localTombstones, localLedger);

			const cloudFiles = cloudManifest?.files ?? {};
			const totalActions = delta.uploadQueue.length + delta.downloadQueue.length + delta.deleteQueue.length + delta.localDeleteQueue.length;
			if (totalActions === 0 && delta.conflictQueue.length === 0) {
				console.log("[S3 Sync] 快速同步：无待传输变更");
				return {uploaded: 0, downloaded: 0, deleted: 0, localDeleted: 0, localDeletedPaths: [], orphanCleaned: 0, failed: [], conflicts: []};
			}

			console.log("[S3 Sync] 快速同步待传输：上传", delta.uploadQueue.length, "下载", delta.downloadQueue.length, "云端删除", delta.deleteQueue.length, "本地删除", delta.localDeleteQueue.length);

			return this.processQueues(delta, localFiles, cloudFiles, deviceId, this.deviceName, cloudManifest, undefined, localTombstones, showFileNotices);
		} finally {
			this.isSyncing = false;
		}
	}
}
