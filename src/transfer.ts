import {DeleteObjectCommand, GetObjectCommand, ListObjectsV2Command, ListObjectsV2CommandOutput, PutObjectCommand, S3Client} from "@aws-sdk/client-s3";
import {Notice, Vault} from "obsidian";
import {S3BackupSettings} from "./settings";
import {computeSyncDelta, FileEntry, FileScanner, normalizeSyncPath, SyncDelta, SyncManifest} from "./scanner";

const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 2000;
const MAX_CONCURRENCY = 3;

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
		deviceId: "",
		lastSyncTime: 0,
		files: {},
	};
}

export interface SyncResult {
	uploaded: number;
	downloaded: number;
	deleted: number;
	orphanCleaned: number;
	failed: Array<{ path: string; error: string }>;
	conflicts: string[];
}

export class S3TransferManager {
	private client: S3Client;
	private bucket: string;
	private vault: Vault;
	private scanner: FileScanner;

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
		this.scanner = new FileScanner(vault.adapter, settings);
	}

	async uploadFile(path: string, content: Uint8Array, mtime: number): Promise<void> {
		const key = cleanS3Key(path);
		await this.client.send(new PutObjectCommand({
			Bucket: this.bucket,
			Key: key,
			Body: content,
			Metadata: {"x-amz-meta-mtime": String(mtime)},
		}));
	}

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
			const parsed = JSON.parse(body) as SyncManifest;
			console.log("[S3 Sync] 云端 manifest 已获取，文件数：", Object.keys(parsed.files).length);
			return parsed;
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
		console.log("[S3 Sync] 上传 manifest.json，文件数：", Object.keys(manifest.files).length);
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
						if (objKey && !manifestKeys.has(objKey)) {
							orphanKeys.push(objKey);
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

		if (orphanKeys.length === 0) {
			console.log("[S3 Sync] 云端无孤儿文件");
			return 0;
		}

		console.log(`[S3 Sync] 发现 ${orphanKeys.length} 个云端孤儿文件：`, orphanKeys);

		let cleaned = 0;
		for (const key of orphanKeys) {
			try {
				await this.client.send(new DeleteObjectCommand({
					Bucket: this.bucket,
					Key: key,
				}));
				cleaned++;
				console.log("[S3 Sync] 已清理孤儿文件：", key);
			} catch (err: unknown) {
				const msg = err instanceof Error ? err.message : String(err);
				console.warn("[S3 Sync] 清理孤儿文件失败：", key, msg);
			}
		}

		console.log(`[S3 Sync] 清理了 ${cleaned} 个云端无主文件`);
		return cleaned;
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
		const adapter = this.vault.adapter;
		const inFlight: Set<Promise<void>> = new Set();
		let nextIndex = 0;

		const executeOne = async (itemPath: string): Promise<void> => {
			let lastError = "";
			for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
				try {
					if (mode === "upload") {
						const rawBuffer = await adapter.readBinary(itemPath);
						const byteContent = new Uint8Array(rawBuffer);
						const itemMtime = localFiles[itemPath]?.mtime ?? Date.now();
						await this.uploadFile(itemPath, byteContent, itemMtime);
						result.uploaded++;
					} else if (mode === "download") {
						const dlData = await this.downloadFile(itemPath);
						await adapter.write(itemPath, dlData.content);
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
		onProgress?: (done: number, total: number) => void,
	): Promise<SyncResult> {
		const result: SyncResult = {
			uploaded: 0,
			downloaded: 0,
			deleted: 0,
			orphanCleaned: 0,
			failed: [],
			conflicts: delta.conflictQueue,
		};
		const uploadPaths = delta.uploadQueue;
		const downloadPaths = delta.downloadQueue;
		const deletePaths = delta.deleteQueue;
		const totalCount = uploadPaths.length + downloadPaths.length + deletePaths.length;
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
			console.log(`[S3 Sync] 开始删除队列，共 ${deletePaths.length} 个文件`);
			await this.runConcurrent(deletePaths, "delete", localFiles, totalCount, doneCount, result);
		}

		// ── 冲突文件 ──
		for (const conflictPath of delta.conflictQueue) {
			try {
				const conflictData = await this.downloadFile(conflictPath);
				const ts = new Date().toISOString().replace(/[:.]/g, "-");
				const ext = conflictPath.includes(".") ? "" : ".md";
				const conflictName = `${conflictPath}.conflict-${ts}${ext}`;
				await this.vault.adapter.write(conflictName, conflictData.content);
				console.log("[S3 Sync] 冲突文件已保存：", conflictName);
			} catch (err: unknown) {
				const msg = err instanceof Error ? err.message : String(err);
				result.failed.push({path: conflictPath, error: `冲突下载失败: ${msg}`});
			}
		}

		// ── 上传最新 manifest（必须执行）──
		try {
			const latestFiles = await this.scanner.scanAll();
			const newManifest: SyncManifest = {
				deviceId,
				lastSyncTime: Date.now(),
				files: latestFiles,
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

	async fullSync(deviceId: string, onProgress?: (done: number, total: number) => void): Promise<SyncResult> {
		console.log("[S3 Sync] 开始全量同步…");
		const localFiles = await this.scanner.scanAll();
		console.log("[S3 Sync] 本地文件扫描完成，文件数：", Object.keys(localFiles).length);

		const cloudManifest = await this.fetchCloudManifest();
		const delta = computeSyncDelta(localFiles, cloudManifest, deviceId);
		console.log("[S3 Sync] Diff 完成：上传", delta.uploadQueue.length, "下载", delta.downloadQueue.length, "删除", delta.deleteQueue.length, "冲突", delta.conflictQueue.length);

		return this.processQueues(delta, localFiles, deviceId, onProgress);
	}

	// ── 快速合并提交 ──

	async quickSync(deviceId: string, recentMs: number): Promise<SyncResult> {
		console.log("[S3 Sync] 开始快速同步，时间窗口：", recentMs, "ms");
		const localFiles = await this.scanner.scanAll();
		const cloudManifest = await this.fetchCloudManifest();
		const cutoff = Date.now() - recentMs;

		// 近期修改的文件 → 上传
		const recentUploads: string[] = [];
		for (const path in localFiles) {
			if (localFiles[path]!.mtime >= cutoff) {
				recentUploads.push(path);
			}
		}

		// 近期本地删除的文件 → 云端删除
		const recentDeletes: string[] = [];
		if (cloudManifest) {
			for (const path in cloudManifest.files) {
				if (!localFiles[path] && cloudManifest.files[path]!.mtime <= cloudManifest.lastSyncTime) {
					recentDeletes.push(path);
				}
			}
		}

		if (recentUploads.length === 0 && recentDeletes.length === 0) {
			console.log("[S3 Sync] 无近期变更，跳过");
			return {uploaded: 0, downloaded: 0, deleted: 0, orphanCleaned: 0, failed: [], conflicts: []};
		}

		console.log("[S3 Sync] 近期变更：上传", recentUploads.length, "删除", recentDeletes.length);
		const delta: SyncDelta = {
			uploadQueue: recentUploads,
			downloadQueue: [],
			deleteQueue: recentDeletes,
			conflictQueue: [],
		};

		return this.processQueues(delta, localFiles, deviceId);
	}
}
