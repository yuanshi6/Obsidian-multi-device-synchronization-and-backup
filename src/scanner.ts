import {DataAdapter, Stat} from "obsidian";
import {S3BackupSettings} from "./settings";

// ── 路径标准化：确保跨平台兼容（Windows \ → /）──

export function normalizeSyncPath(path: string): string {
	return path.split("\\").join("/");
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
			// 将通配符模式转为正则：* → .*, ? → .
			const escaped = p
				.replace(/[.+^${}()|[\]\\]/g, "\\$&")
				.replace(/\*/g, ".*")
				.replace(/\?/g, ".");
			// 匹配路径中任意位置出现该模式
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
			if (this.isExcluded(filePath)) continue;
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

// ── Diff 算法 ──

export function computeSyncDelta(
	localFiles: Record<string, FileEntry>,
	cloudManifest: SyncManifest | null,
): SyncDelta {
	const uploadQueue: string[] = [];
	const downloadQueue: string[] = [];
	const conflictQueue: string[] = [];

	const cloudFiles = cloudManifest?.files ?? {};
	const lastSyncTime = cloudManifest?.lastSyncTime ?? 0;

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
			// 仅云端存在 → 下载
			downloadQueue.push(path);
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

	return {uploadQueue, downloadQueue, conflictQueue};
}
