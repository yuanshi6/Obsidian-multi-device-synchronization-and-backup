import {GetObjectCommand, PutObjectCommand, S3Client} from "@aws-sdk/client-s3";
import {Vault} from "obsidian";
import {S3BackupSettings} from "./settings";
import {computeSyncDelta, FileEntry, FileScanner, normalizeSyncPath, SyncDelta, SyncManifest} from "./scanner";

const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 2000;

type SyncTask = { type: "upload"; path: string } | { type: "download"; path: string };

// ── 同步结果 ──

export interface SyncResult {
	uploaded: number;
	downloaded: number;
	failed: Array<{ path: string; error: string }>;
	conflicts: string[];
}

// ── 传输管理器 ──

export class S3TransferManager {
	private client: S3Client;
	private bucket: string;
	private vault: Vault;
	private scanner: FileScanner;

	constructor(vault: Vault, settings: S3BackupSettings) {
		this.client = new S3Client({
			credentials: {
				accessKeyId: settings.accessKey,
				secretAccessKey: settings.secretKey,
			},
			endpoint: settings.endpoint,
			region: settings.region || "us-east-1",
			forcePathStyle: true,
		});
		this.bucket = settings.bucketName;
		this.vault = vault;
		this.scanner = new FileScanner(vault.adapter, settings);
	}

	async uploadFile(path: string, content: string, mtime: number): Promise<void> {
		await this.client.send(new PutObjectCommand({
			Bucket: this.bucket,
			Key: normalizeSyncPath(path),
			Body: content,
			Metadata: {"x-amz-meta-mtime": String(mtime)},
		}));
	}

	async downloadFile(path: string): Promise<{ content: string; mtime: number | null }> {
		const resp = await this.client.send(new GetObjectCommand({
			Bucket: this.bucket,
			Key: normalizeSyncPath(path),
		}));

		const body = await resp.Body!.transformToString("utf-8");
		const mtimeStr = resp.Metadata?.["x-amz-meta-mtime"];
		const mtime = mtimeStr ? parseInt(mtimeStr, 10) : null;

		return {content: body, mtime};
	}

	async fetchCloudManifest(): Promise<SyncManifest | null> {
		try {
			const resp = await this.client.send(new GetObjectCommand({
				Bucket: this.bucket,
				Key: "manifest.json",
			}));
			const body = await resp.Body!.transformToString("utf-8");
			return JSON.parse(body) as SyncManifest;
		} catch {
			return null;
		}
	}

	async uploadManifest(manifest: SyncManifest): Promise<void> {
		await this.client.send(new PutObjectCommand({
			Bucket: this.bucket,
			Key: "manifest.json",
			Body: JSON.stringify(manifest, null, "\t"),
			ContentType: "application/json",
		}));
	}

	// ── 并发队列 ──

	async processQueues(
		delta: SyncDelta,
		localFiles: Record<string, FileEntry>,
		deviceId: string,
		onProgress?: (done: number, total: number) => void,
	): Promise<SyncResult> {
		const result: SyncResult = {
			uploaded: 0,
			downloaded: 0,
			failed: [],
			conflicts: delta.conflictQueue,
		};

		const tasks: SyncTask[] = [
			...delta.uploadQueue.map(p => ({type: "upload" as const, path: p})),
			...delta.downloadQueue.map(p => ({type: "download" as const, path: p})),
		];

		const total = tasks.length;
		let done = 0;
		let running = 0;
		let nextIdx = 0;

		const adapter = this.vault.adapter;

		const runTask = async (task: SyncTask): Promise<void> => {
			let lastError: string = "";
			for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
				try {
					if (task.type === "upload") {
						const content = await adapter.read(task.path);
						const mtime = localFiles[task.path]?.mtime ?? Date.now();
						await this.uploadFile(task.path, content, mtime);
						result.uploaded++;
					} else {
						const {content} = await this.downloadFile(task.path);
						await adapter.write(task.path, content);
						result.downloaded++;
					}
					break;
				} catch (err: unknown) {
					lastError = err instanceof Error ? err.message : String(err);
					if (attempt < MAX_RETRIES) {
						await new Promise(r => setTimeout(r, RETRY_DELAY_MS));
					}
				}
			}
			if (lastError) {
				result.failed.push({path: task.path, error: lastError});
			}
			running--;
			done++;
			onProgress?.(done, total);
		};

		await new Promise<void>((resolveAll) => {
			const tryNext = (): void => {
				while (running < 3 && nextIdx < tasks.length) {
					const task = tasks[nextIdx]!;
					nextIdx++;
					running++;
					runTask(task).then(tryNext);
				}

				if (running === 0 && nextIdx >= tasks.length) {
					resolveAll();
				}
			};

			tryNext();
		});

		// 处理冲突文件：下载云端版本为 .conflict-[时间戳] 副本，保护本地数据
		for (const conflictPath of delta.conflictQueue) {
			try {
				const {content} = await this.downloadFile(conflictPath);
				const ts = new Date().toISOString().replace(/[:.]/g, "-");
				const ext = conflictPath.includes(".") ? "" : ".md";
				const conflictName = `${conflictPath}.conflict-${ts}${ext}`;
				await adapter.write(conflictName, content);
			} catch (err: unknown) {
				const msg = err instanceof Error ? err.message : String(err);
				result.failed.push({path: conflictPath, error: `冲突下载失败: ${msg}`});
			}
		}

		// 队列完成后，重新扫描并上传最新 manifest
		const latestFiles = await this.scanner.scanAll();
		const newManifest: SyncManifest = {
			deviceId,
			lastSyncTime: Date.now(),
			files: latestFiles,
		};
		await this.uploadManifest(newManifest);

		return result;
	}

	// ── 一键同步入口 ──

	async fullSync(deviceId: string, onProgress?: (done: number, total: number) => void): Promise<SyncResult> {
		const localFiles = await this.scanner.scanAll();
		const cloudManifest = await this.fetchCloudManifest();
		const delta = computeSyncDelta(localFiles, cloudManifest);
		return this.processQueues(delta, localFiles, deviceId, onProgress);
	}

	// ── 快速合并提交（仅上传近 recentMs 毫秒内修改的文件）──

	async quickSync(deviceId: string, recentMs: number): Promise<SyncResult> {
		const localFiles = await this.scanner.scanAll();
		const cutoff = Date.now() - recentMs;

		const recentPaths: string[] = [];
		for (const path in localFiles) {
			if (localFiles[path]!.mtime >= cutoff) {
				recentPaths.push(path);
			}
		}

		if (recentPaths.length === 0) {
			return {uploaded: 0, downloaded: 0, failed: [], conflicts: []};
		}

		const delta: SyncDelta = {
			uploadQueue: recentPaths,
			downloadQueue: [],
			conflictQueue: [],
		};

		return this.processQueues(delta, localFiles, deviceId);
	}
}
