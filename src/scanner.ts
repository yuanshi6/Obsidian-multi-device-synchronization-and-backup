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
	hash: string;
	lastModifiedBy: string;
}

export interface DeletedEntry {
	mtime: number;
	deletedBy: string;
}

export interface SyncManifest {
	version: string;
	deviceId: string;
	deviceName: string;
	lastSyncTime: number;
	files: Record<string, FileEntry>;
	deleted: Record<string, DeletedEntry>;
}

// ── Diff 输出 ──

export interface SyncDelta {
	uploadQueue: string[];
	downloadQueue: string[];
	deleteQueue: string[];       // 删除云端文件（本地已删除）
	localDeleteQueue: string[];  // 删除本地文件（云端已删除）
	conflictQueue: string[];
}

// ── 文件扫描器 ──

export class FileScanner {
	private adapter: DataAdapter;
	private excludeRegex: RegExp | null;
	private deviceId: string;

	constructor(adapter: DataAdapter, settings: S3BackupSettings) {
		this.adapter = adapter;
		this.deviceId = settings.deviceId;
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
				const normalized = normalizeSyncPath(filePath);
				result[normalized] = {
					mtime: stat.mtime,
					size: stat.size,
					hash: `${stat.size}-${Math.floor(stat.mtime)}`,
					lastModifiedBy: this.deviceId,
				};
			}
		}

		for (const folder of folders) {
			if (this.isExcluded(folder)) continue;
			await this.walk(folder, result);
		}
	}
}

// ── Diff 算法（LWW 四象限 + 墓碑机制）──
// 铁律 1：绝对 LWW 时间戳仲裁 — 谁的 mtime 更晚谁赢
// 铁律 2：无空引用删除 — 云端缺失的本地文件一律视为"本地新增"上传
// 铁律 3：墓碑机制 — 本地删除被拦截为墓碑，墓碑时间戳与云端 mtime 竞争

export function computeSyncDelta(
	localFiles: Record<string, FileEntry>,
	cloudManifest: SyncManifest | null,
	currentDeviceId: string = "",
	localLastSyncTime: number = 0,
	localTombstones: Record<string, DeletedEntry> = {},
): SyncDelta {
	const uploadQueue: string[] = [];
	const downloadQueue: string[] = [];
	const deleteQueue: string[] = [];
	const localDeleteQueue: string[] = [];
	const conflictQueue: string[] = [];

	const cloudFiles = cloudManifest?.files ?? {};
	const cloudDeleted = cloudManifest?.deleted ?? {};

	// 收集所有涉及路径：本地文件 + 云端文件 + 本地墓碑 + 云端墓碑
	const allPaths = new Set<string>([
		...Object.keys(localFiles),
		...Object.keys(cloudFiles),
		...Object.keys(localTombstones),
		...Object.keys(cloudDeleted),
	]);

	for (const path of allPaths) {
		const local = localFiles[path];
		const cloud = cloudFiles[path];
		const localTomb = localTombstones[path];
		const cloudTomb = cloudDeleted[path];

		// ── 第一象限：墓碑检查（优先级最高）──

		if (localTomb && cloudTomb) {
			// 两端都有墓碑 → 无需操作，保留较新的墓碑即可
			// 墓碑合并由 processQueues 在构建新 manifest 时处理
			continue;
		}

		if (localTomb && !cloudTomb) {
			// 本地已删除，云端无墓碑
			if (cloud) {
				// 云端文件仍存在 → LWW：本地墓碑时间 vs 云端 mtime
				if (localTomb.mtime >= cloud.mtime) {
					// 墓碑更新或同时 → 删云端
					deleteQueue.push(path);
				} else {
					// 云端更新 → 下载到本地（墓碑被覆盖）
					downloadQueue.push(path);
				}
			}
			// 云端也不存在 → 两端都已删除，无需操作
			continue;
		}

		if (!localTomb && cloudTomb) {
			// 云端有墓碑，本地无墓碑
			if (local) {
				// 本地文件仍存在 → LWW：云端墓碑时间 vs 本地 mtime
				if (cloudTomb.mtime >= local.mtime) {
					// 墓碑更新或同时 → 删本地
					localDeleteQueue.push(path);
				} else {
					// 本地更新 → 上传（覆盖墓碑）
					uploadQueue.push(path);
				}
			}
			// 本地也不存在 → 两端都已删除，无需操作
			continue;
		}

		// ── 第二象限：仅本地存在（无墓碑）──

		if (local && !cloud) {
			// 铁律 2：云端缺失 = 本地新增 → 上传
			uploadQueue.push(path);
			continue;
		}

		// ── 第三象限：仅云端存在（无墓碑）──

		if (!local && cloud) {
			// 铁律 2 对称：本地缺失 = 云端新增 → 下载
			downloadQueue.push(path);
			continue;
		}

		// ── 第四象限：两端都存在 → LWW mtime 比较 ──

		if (local && cloud) {
			if (local.mtime === cloud.mtime) continue;

			// 铁律 1：绝对 LWW — mtime 更晚者胜
			if (local.mtime > cloud.mtime) {
				uploadQueue.push(path);
			} else {
				downloadQueue.push(path);
			}
		}
	}

	return {uploadQueue, downloadQueue, deleteQueue, localDeleteQueue, conflictQueue};
}
