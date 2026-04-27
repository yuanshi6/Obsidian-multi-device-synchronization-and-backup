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

// ── 观察者模式：FileState ──

export interface FileState {
	lastPenDropTime: number; // 观察者记录的用户真实落笔修改时间
	isUploaded: boolean;     // 脏读标记：是否已成功同步至云端
	hash: string;            // 文件内容校验哈希
	lastModifiedBy: string;  // 设备 ID
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
	files: Record<string, FileState>;
	deleted: Record<string, DeletedEntry>;
}

// ── Diff 输出 ──

export interface SyncDelta {
	uploadQueue: string[];
	downloadQueue: string[];
	deleteQueue: string[];       // 删除云端文件（本地已删除）
	localDeleteQueue: string[];  // 删除本地文件（云端已删除）
	conflictQueue: string[];
	// 任务四：哈希缝合 — 同名同 Hash 文件无缝编入账本
	hashStitched: string[];     // 无需传输，直接编入本地账本的路径
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

	async scanAll(): Promise<Record<string, FileState>> {
		const result: Record<string, FileState> = {};
		await this.walk("", result);
		return result;
	}

	private async walk(dir: string, result: Record<string, FileState>): Promise<void> {
		const {files, folders} = await this.adapter.list(dir);

		for (const filePath of files) {
			if (this.isExcluded(filePath) || isSystemFile(filePath)) continue;
			const stat = await this.adapter.stat(filePath);
			if (stat && stat.mtime != null) {
				const normalized = normalizeSyncPath(filePath);
				result[normalized] = {
					lastPenDropTime: stat.mtime,
					isUploaded: false,
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

// ══════════════════════════════════════════════════════════
// Diff 算法（观察者模式 + 墓碑 + 哈希缝合安全网）
// ══════════════════════════════════════════════════════════

export function computeSyncDelta(
	localFiles: Record<string, FileState>,
	cloudManifest: SyncManifest | null,
	currentDeviceId: string = "",
	localTombstones: Record<string, DeletedEntry> = {},
	localLedger: Record<string, FileState> = {},
): SyncDelta {
	const uploadQueue: string[] = [];
	const downloadQueue: string[] = [];
	const deleteQueue: string[] = [];
	const localDeleteQueue: string[] = [];
	const conflictQueue: string[] = [];
	const hashStitched: string[] = [];

	const cloudFiles = cloudManifest?.files ?? {};
	const cloudDeleted = cloudManifest?.deleted ?? {};

	// 收集所有涉及路径
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
		const ledgerEntry = localLedger[path];

		// ── 墓碑检查（优先级最高）──

		if (localTomb && cloudTomb) {
			continue;
		}

		if (localTomb && !cloudTomb) {
			if (cloud) {
				if (localTomb.mtime >= cloud.lastPenDropTime) {
					deleteQueue.push(path);
				} else {
					downloadQueue.push(path);
				}
			}
			continue;
		}

		if (!localTomb && cloudTomb) {
			if (local) {
				if (cloudTomb.mtime >= local.lastPenDropTime) {
					localDeleteQueue.push(path);
				} else {
					uploadQueue.push(path);
				}
			}
			continue;
		}

		// ── 无墓碑：观察者判定 ──

		if (local && !cloud) {
			// 仅本地存在
			if (!local.isUploaded) {
				uploadQueue.push(path);
			}
			continue;
		}

		if (!local && cloud) {
			// 仅云端存在 → 下载
			downloadQueue.push(path);
			continue;
		}

		if (local && cloud) {
			// ══════════════════════════════════════════════════
			// 任务四：哈希缝合安全网 (Hash Fallback)
			// ══════════════════════════════════════════════════
			// 场景：冷启动/换手机，本地账本为空，但本地和云端都有同名文件
			// 如果 Hash 一致 → 无需传输，直接编入账本
			if (!ledgerEntry && local.hash && cloud.hash && local.hash === cloud.hash) {
				hashStitched.push(path);
				continue;
			}

			// 正常观察者判定
			if (local.lastPenDropTime === cloud.lastPenDropTime) {
				if (!local.isUploaded) {
					uploadQueue.push(path);
				}
				continue;
			}

			if (local.lastPenDropTime > cloud.lastPenDropTime) {
				uploadQueue.push(path);
			} else {
				downloadQueue.push(path);
			}
		}
	}

	return {uploadQueue, downloadQueue, deleteQueue, localDeleteQueue, conflictQueue, hashStitched};
}
