import {DeleteObjectCommand, GetObjectCommand, ListObjectsV2Command, ListObjectsV2CommandOutput, PutObjectCommand, S3Client} from "@aws-sdk/client-s3";
import {Notice, Vault} from "obsidian";
import {S3BackupSettings} from "./settings";
import {computeSyncDelta, DeletedEntry, FileEntry, FileScanner, normalizeSyncPath, SyncDelta, SyncManifest} from "./scanner";

const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 2000;
const MAX_CONCURRENCY = 3;
const DELETED_EXPIRY_MS = 30 * 24 * 60 * 60 * 1000; // 30 天

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
		version: "2.0",
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

	// 同步回音防御：下载后对齐的本地 mtime 快照
	public localManifest: Record<string, FileEntry> = {};

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

	async uploadFile(path: string, content: Uint8Array, mtime: number): Promise<void> {
		const key = cleanS3Key(path);
		await this.client.send(new PutObjectCommand({
			Bucket: this.bucket,
			Key: key,
			Body: content,
			Metadata: {"x-amz-meta-mtime": String(mtime)},
		}));
	}

	private async readLocalFile(path: string): Promise<Uint8Array> {
		if (isBinaryPath(path)) {
			// 二进制文件：严格使用 readBinary → ArrayBuffer → Uint8Array
			const arrayBuffer = await this.vault.adapter.readBinary(path);
			return new Uint8Array(arrayBuffer);
		}
		// 文本文件：read → string → Uint8Array
		const text = await this.vault.adapter.read(path);
		const encoder = new TextEncoder();
		return encoder.encode(text);
	}

	// ── 下载：二进制走 transformToByteArray + writeBinary，文本走 transformToString + write ──

	async downloadFile(path: string): Promise<{ content: string; mtime: number | null }> {
		const key = cleanS3Key(path);
		const resp = await this.client.send(new GetObjectCommand({
			Bucket: this.bucket,
			Key: key,
		}));
		const body = await resp.Body!.transformToString("utf-8");
		const mtimeStr = resp.Metadata?.["x-amz-meta-mtime"];
		const mtime = mtimeStr ? parseInt(mtimeStr, 10) : null;
		return {content: body, mtime};
	}

	private async downloadAndWriteFile(path: string): Promise<{ mtime: number | null }> {
		const key = cleanS3Key(path);
		const resp = await this.client.send(new GetObjectCommand({
			Bucket: this.bucket,
			Key: key,
		}));

		const mtimeStr = resp.Metadata?.["x-amz-meta-mtime"];
		const mtime = mtimeStr ? parseInt(mtimeStr, 10) : null;

		if (isBinaryPath(path)) {
			// 二进制文件：transformToByteArray → writeBinary
			const bytes = await resp.Body!.transformToByteArray();
			const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
			await this.vault.adapter.writeBinary(path, buffer);
		} else {
			// 文本文件：transformToString → write
			const text = await resp.Body!.transformToString("utf-8");
			await this.vault.adapter.write(path, text);
		}

		return {mtime};
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
			const body = await resp.Body!.transformToString("utf-8");
			const parsed = JSON.parse(body);

			// V1 → V2 兼容迁移
			if (!parsed.version) {
				console.log("[S3 Sync] 检测到 V1 manifest，自动升级为 V2");
				parsed.version = "2.0";
				parsed.deviceName = parsed.deviceName ?? "";
				if (parsed.deleted) {
					const migrated: Record<string, DeletedEntry> = {};
					for (const [path, val] of Object.entries(parsed.deleted)) {
						if (typeof val === "number") {
							migrated[path] = {mtime: val, deletedBy: ""};
						} else {
							migrated[path] = val as DeletedEntry;
						}
					}
					parsed.deleted = migrated;
				}
				if (parsed.files) {
					for (const entry of Object.values(parsed.files) as Array<Record<string, unknown>>) {
						if (!entry.hash) entry.hash = `${entry.size}-${Math.floor(entry.mtime as number)}`;
						if (!entry.lastModifiedBy) entry.lastModifiedBy = "";
					}
				}
			}

			if (!parsed.deleted) parsed.deleted = {};
			console.log("[S3 Sync] 云端 manifest 已获取，文件数：", Object.keys(parsed.files).length, "删除记录：", Object.keys(parsed.deleted).length);
			return parsed as SyncManifest;
		} catch (err: unknown) {
			const errName = (err as { name?: string })?.name ?? "";
			const httpStatus = (err as { $metadata?: { httpStatusCode?: number } })?.$metadata?.httpStatusCode;
			if (httpStatus === 404 || errName === "NoSuchKey" || errName === "NotFound") {
				console.log("[S3 Sync] 云端无 manifest.json，返回空白初始结构");
			} else {
				console.warn("[S3 Sync] 获取云端 manifest 失败：", err);
			}
			return emptyManifest();
		}
	}

	async uploadManifest(manifest: SyncManifest): Promise<void> {
		console.log("[S3 Sync] 上传 manifest.json，文件数：", Object.keys(manifest.files).length, "删除记录：", Object.keys(manifest.deleted).length);
		await this.client.send(new PutObjectCommand({
			Bucket: this.bucket,
			Key: "manifest.json",
			Body: JSON.stringify(manifest, null, "\t"),
			ContentType: "application/json",
		}));
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

	// ── 并发池：for 循环 + Set + Promise.race ──

	private async runConcurrent(
		paths: string[],
		mode: "upload" | "download" | "delete",
		localFiles: Record<string, FileEntry>,
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
						// 上传：二进制走 readBinary，文本走 read
						const byteContent = await this.readLocalFile(itemPath);
						const itemMtime = localFiles[itemPath]?.mtime ?? Date.now();
						await this.uploadFile(itemPath, byteContent, itemMtime);
						result.uploaded++;
					} else if (mode === "download") {
						// 下载：二进制走 writeBinary，文本走 write
						await this.downloadAndWriteFile(itemPath);

						// ── 同步回音防御：下载后立刻对齐本地 mtime ──
						const stat = await this.vault.adapter.stat(itemPath);
						if (stat && stat.mtime != null) {
							this.localManifest[itemPath] = {
								mtime: stat.mtime,
								size: stat.size,
								hash: `${stat.size}-${Math.floor(stat.mtime)}`,
								lastModifiedBy: this.deviceId,
							};
						}

						result.downloaded++;
					} else {
						await this.deleteFile(itemPath);
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
		localFiles: Record<string, FileEntry>,
		deviceId: string,
		deviceName: string,
		cloudManifest: SyncManifest,
		onProgress?: (done: number, total: number) => void,
	): Promise<SyncResult> {
		const result: SyncResult = {
			uploaded: 0,
			downloaded: 0,
			deleted: 0,
			localDeleted: 0,
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
			await this.runConcurrent(uploadPaths, "upload", localFiles, totalCount, doneCount, result);
		}

		// ── 下载 ──
		if (downloadPaths.length > 0) {
			console.log(`[S3 Sync] 开始下载队列，共 ${downloadPaths.length} 个文件`);
			await this.runConcurrent(downloadPaths, "download", localFiles, totalCount, doneCount, result);
		}

		// ── 云端删除 ──
		if (deletePaths.length > 0) {
			console.log(`[S3 Sync] 开始云端删除队列，共 ${deletePaths.length} 个文件`);
			await this.runConcurrent(deletePaths, "delete", localFiles, totalCount, doneCount, result);
		}

		// ── 本地删除 ──
		if (localDeletePaths.length > 0) {
			console.log(`[S3 Sync] 开始本地删除队列，共 ${localDeletePaths.length} 个文件`);
			for (const localPath of localDeletePaths) {
				try {
					if (await this.vault.adapter.exists(localPath)) {
						await this.vault.adapter.remove(localPath);
						result.localDeleted++;
						console.log("[S3 Sync] 已删除本地文件：", localPath);
					}
				} catch (err: unknown) {
					const msg = err instanceof Error ? err.message : String(err);
					result.failed.push({path: localPath, error: `本地删除失败: ${msg}`});
				}
			}
		}

		// ── 冲突文件：云端优先，本地旧版本保存为 .conflict ──
		for (const conflictPath of delta.conflictQueue) {
			try {
				const conflictData = await this.downloadFile(conflictPath);
				try {
					const localContent = await this.vault.adapter.read(conflictPath);
					const ts = new Date().toISOString().replace(/[:.]/g, "-");
					const conflictName = `${conflictPath}.conflict-${ts}.md`;
					await this.vault.adapter.write(conflictName, localContent);
					console.log("[S3 Sync] 冲突：本地版本已保存为：", conflictName);
				} catch (readErr: unknown) {
					console.warn("[S3 Sync] 冲突：无法读取本地版本，跳过保存：", readErr);
				}
				await this.vault.adapter.write(conflictPath, conflictData.content);
				console.log("[S3 Sync] 冲突：已用云端版本覆盖本地：", conflictPath);
			} catch (err: unknown) {
				const msg = err instanceof Error ? err.message : String(err);
				result.failed.push({path: conflictPath, error: `冲突处理失败: ${msg}`});
			}
		}

		// ── 上传最新 manifest（必须执行）──
		// 使用 localManifest（已含下载后对齐的 mtime）而非重新扫描
		try {
			const now = Date.now();

			// 合并删除记录：保留云端已有的 + 本地删除的 + 清理过期记录
			const mergedDeleted: Record<string, DeletedEntry> = {};
			for (const [path, entry] of Object.entries(cloudManifest.deleted ?? {})) {
				if (now - entry.mtime < DELETED_EXPIRY_MS) {
					mergedDeleted[path] = entry;
				}
			}
			// 本地删除的文件也加入 deleted 记录
			for (const path of localDeletePaths) {
				mergedDeleted[path] = {mtime: now, deletedBy: deviceId};
			}
			// 云端删除的文件也加入
			for (const path of deletePaths) {
				mergedDeleted[path] = {mtime: now, deletedBy: deviceId};
			}
			// 上传/下载成功的文件从 deleted 中移除
			for (const path of uploadPaths) {
				delete mergedDeleted[path];
			}
			for (const path of downloadPaths) {
				delete mergedDeleted[path];
			}

			const newManifest: SyncManifest = {
				version: "2.0",
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

	async fullSync(deviceId: string, localLastSyncTime: number, onProgress?: (done: number, total: number) => void, localTombstones: Record<string, DeletedEntry> = {}): Promise<SyncResult> {
		if (this.isSyncing) {
			console.log("[S3 Sync] 当前已有同步任务正在进行，跳过本次触发");
			return {uploaded: 0, downloaded: 0, deleted: 0, localDeleted: 0, orphanCleaned: 0, failed: [], conflicts: []};
		}
		this.isSyncing = true;
		try {
			console.log("[S3 Sync] 开始执行增量同步...");
			const localFiles = await this.scanner.scanAll();
			console.log("[S3 Sync] 本地文件扫描完成，文件数：", Object.keys(localFiles).length);

			// 初始化 localManifest 快照（后续下载会实时更新 mtime）
			this.localManifest = {...localFiles};

			const cloudManifest = await this.fetchCloudManifest();
			const orphanCleaned = await this.cleanOrphanFiles(cloudManifest);
			const delta = computeSyncDelta(localFiles, cloudManifest, deviceId, localLastSyncTime, localTombstones);

			console.log("[S3 Sync] 待上传队列:", delta.uploadQueue);
			console.log("[S3 Sync] 待下载队列:", delta.downloadQueue);
			console.log("[S3 Sync] 云端删除队列:", delta.deleteQueue);
			console.log("[S3 Sync] 本地删除队列:", delta.localDeleteQueue);
			console.log("[S3 Sync] 冲突队列:", delta.conflictQueue);

			const syncResult = await this.processQueues(delta, localFiles, deviceId, this.deviceName, cloudManifest, onProgress);
			syncResult.orphanCleaned = orphanCleaned;

			console.log("[S3 Sync] 同步完成，已生成最新 manifest.json");
			return syncResult;
		} finally {
			this.isSyncing = false;
		}
	}

	// ── 快速合并提交 ──

	async quickSync(deviceId: string, localLastSyncTime: number, recentMs: number, localTombstones: Record<string, DeletedEntry> = {}): Promise<SyncResult> {
		if (this.isSyncing) {
			console.log("[S3 Sync] 当前已有同步任务正在进行，跳过本次触发");
			return {uploaded: 0, downloaded: 0, deleted: 0, localDeleted: 0, orphanCleaned: 0, failed: [], conflicts: []};
		}
		this.isSyncing = true;
		try {
			console.log("[S3 Sync] 开始快速同步，时间窗口：", recentMs, "ms");
			const localFiles = await this.scanner.scanAll();
			this.localManifest = {...localFiles};

			const cloudManifest = await this.fetchCloudManifest();

			const delta = computeSyncDelta(localFiles, cloudManifest, deviceId, localLastSyncTime, localTombstones);

			const cutoff = Date.now() - recentMs;
			const cloudFiles = cloudManifest?.files ?? {};
			const recentDelta: SyncDelta = {
				uploadQueue: delta.uploadQueue.filter(p => (localFiles[p]?.mtime ?? 0) >= cutoff),
				downloadQueue: delta.downloadQueue.filter(p => (localFiles[p]?.mtime ?? 0) >= cutoff || (cloudFiles[p]?.mtime ?? 0) >= cutoff),
				deleteQueue: delta.deleteQueue,
				localDeleteQueue: delta.localDeleteQueue,
				conflictQueue: delta.conflictQueue.filter(p => (localFiles[p]?.mtime ?? 0) >= cutoff || (cloudFiles[p]?.mtime ?? 0) >= cutoff),
			};

			const totalActions = recentDelta.uploadQueue.length + recentDelta.downloadQueue.length + recentDelta.deleteQueue.length + recentDelta.localDeleteQueue.length;
			if (totalActions === 0 && recentDelta.conflictQueue.length === 0) {
				console.log("[S3 Sync] 无近期变更，跳过");
				return {uploaded: 0, downloaded: 0, deleted: 0, localDeleted: 0, orphanCleaned: 0, failed: [], conflicts: []};
			}

			console.log("[S3 Sync] 近期变更：上传", recentDelta.uploadQueue.length, "下载", recentDelta.downloadQueue.length, "云端删除", recentDelta.deleteQueue.length, "本地删除", recentDelta.localDeleteQueue.length, "冲突", recentDelta.conflictQueue.length);

			return this.processQueues(recentDelta, localFiles, deviceId, this.deviceName, cloudManifest);
		} finally {
			this.isSyncing = false;
		}
	}
}
