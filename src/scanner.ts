import {DataAdapter} from "obsidian";
import {S3BackupSettings} from "./settings";

// ── 路径标准化：确保跨平台兼容（Windows \ → /）──

export function normalizeSyncPath(path: string): string {
	return path.split("\\").join("/");
}

const SYSTEM_FILE_NAMES = new Set([".DS_Store", "Thumbs.db", "desktop.ini"]);

function isSystemFile(path: string): boolean {
	const parts = path.split("/");
	const fileName = parts[parts.length - 1] ?? "";
	return SYSTEM_FILE_NAMES.has(fileName);
}

// ── Manifest 类型定义 ──

export interface FileEntry {
	mtime: number;
	size: number;
}

export interface SyncManifest {
	deviceId: string;
	lastSyncTime: number;
	files: Record<string, FileEntry>;
}

// ── Diff 输出 ──

export interface SyncDelta {
	uploadQueue: string[];
	downloadQueue: string[];
	deleteQueue: string[];
	conflictQueue: string[];
}

// ── 文件扫描器 ──

export class FileScanner {
	private adapter: DataAdapter;
	private excludeRegex: RegExp | null;

	constructor(adapter: DataAdapter, settings: S3BackupSettings) {
		this.adapter = adapter;
		this.excludeRegex = this.buildExcludeRegex(settings.excludePatterns);
	}

	private buildExcludeRegex(patterns: string): RegExp | null {
		const trimmed = patterns.split(",")
			.map(p => p.trim())
			.filter(p => p.length > 0);
		if (trimmed.length === 0) return null;

		const parts = trimmed.map(p => {
			const escaped = p
				.replace(/[.+^${}()|[\]\\]/g, "\\$&")
				.replace(/\*/g, ".*")
				.replace(/\?/g, ".");
			return `(?:^|/)${escaped}(?:/|$)`;
		});
		return new RegExp(parts.join("|"));
	}

	private isExcluded(path: string): boolean {
		if (!this.excludeRegex) return false;
		return this.excludeRegex.test(path);
	}

	async scanAll(): Promise<Record<string, FileEntry>> {
		const result: Record<string, FileEntry> = {};
		await this.walk("", result);
		return result;
	}

	private async walk(dir: string, result: Record<string, FileEntry>): Promise<void> {
		const {files, folders} = await this.adapter.list(dir);

		for (const filePath of files) {
			if (this.isExcluded(filePath) || isSystemFile(filePath)) continue;
			const stat = await this.adapter.stat(filePath);
			if (stat && stat.mtime != null) {
				result[normalizeSyncPath(filePath)] = {mtime: stat.mtime, size: stat.size};
			}
		}

		for (const folder of folders) {
			if (this.isExcluded(folder)) continue;
			await this.walk(folder, result);
		}
	}
}

// ── Diff 算法（支持双向删除同步）──

export function computeSyncDelta(
	localFiles: Record<string, FileEntry>,
	cloudManifest: SyncManifest | null,
	currentDeviceId: string = "",
): SyncDelta {
	const uploadQueue: string[] = [];
	const downloadQueue: string[] = [];
	const deleteQueue: string[] = [];
	const conflictQueue: string[] = [];

	const cloudFiles = cloudManifest?.files ?? {};
	const lastSyncTime = cloudManifest?.lastSyncTime ?? 0;
	const manifestDeviceId = cloudManifest?.deviceId ?? "";

	const allPaths = new Set<string>([
		...Object.keys(localFiles),
		...Object.keys(cloudFiles),
	]);

	for (const path of allPaths) {
		const local = localFiles[path];
		const cloud = cloudFiles[path];

		if (local && !cloud) {
			// 仅本地存在 → 上传
			uploadQueue.push(path);
		} else if (!local && cloud) {
			// 仅云端存在
			if (currentDeviceId && manifestDeviceId && currentDeviceId === manifestDeviceId) {
				// manifest 是本机上次上传的 → 本地已删除，从云端删除
				deleteQueue.push(path);
			} else if (lastSyncTime > 0 && cloud.mtime <= lastSyncTime) {
				// 云端 mtime 早于上次同步 → 本地已删除
				deleteQueue.push(path);
			} else {
				// 其他设备新增 → 下载到本地
				downloadQueue.push(path);
			}
		} else if (local && cloud) {
			// 两端都存在，比较 mtime
			if (local.mtime === cloud.mtime) continue;

			const localChanged = local.mtime > lastSyncTime;
			const cloudChanged = cloud.mtime > lastSyncTime;

			if (localChanged && cloudChanged) {
				// 两端均在同步后修改 → 冲突
				conflictQueue.push(path);
			} else if (localChanged) {
				uploadQueue.push(path);
			} else {
				downloadQueue.push(path);
			}
		}
	}

	return {uploadQueue, downloadQueue, deleteQueue, conflictQueue};
}
