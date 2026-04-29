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

// ── 版本链模型：FileState ──

export interface FileState {
	fileId: string;
	version: number;         // 当前已确认的云端版本；本地脏改不会提前自增
	baseVersion: number;     // 本地内容基于哪个云端版本产生
	contentHash: string;     // 真实 SHA-256 内容哈希
	mtime: number;           // 仅作显示/元数据，不参与新旧判定
	lastModifiedBy: string;  // 设备 ID
	remoteRevision?: string; // S3 ETag/generation 等远端修订号
	parentHash?: string;     // baseVersion 对应的内容哈希
	deleted?: boolean;

	// Legacy fields accepted during migration only. New code must not decide by them.
	lastPenDropTime?: number;
	isUploaded?: boolean;
	hash?: string;
}

export interface DeletedEntry {
	mtime: number;
	deletedBy: string;
	version: number;
	baseVersion: number;
	fileId?: string;
	contentHash?: string;
	remoteRevision?: string;
	ackedBy?: Record<string, number>;
}

export interface SyncManifest {
	version: string;
	deviceId: string;
	deviceName: string;
	lastSyncTime: number;
	files: Record<string, FileState>;
	deleted: Record<string, DeletedEntry>;
	remoteRevision?: string;
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

const SHA256_HEX_RE = /^[a-f0-9]{64}$/i;

function toNumber(value: unknown, fallback: number): number {
	return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function toString(value: unknown, fallback = ""): string {
	return typeof value === "string" ? value : fallback;
}

function bytesToHex(bytes: Uint8Array): string {
	return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function sha256Hex(content: Uint8Array): Promise<string> {
	if (!globalThis.crypto?.subtle) {
		throw new Error("Web Crypto SHA-256 is unavailable in this environment");
	}
	const buffer = content.buffer.slice(content.byteOffset, content.byteOffset + content.byteLength);
	const digest = await globalThis.crypto.subtle.digest("SHA-256", buffer);
	return bytesToHex(new Uint8Array(digest));
}

export function isTrustedContentHash(hash: string | undefined): boolean {
	return typeof hash === "string" && SHA256_HEX_RE.test(hash);
}

export function normalizeFileState(path: string, raw: Partial<FileState>, fallbackDeviceId = ""): FileState {
	const legacyUploaded = typeof raw.isUploaded === "boolean" ? raw.isUploaded : undefined;
	const contentHash = toString(raw.contentHash, toString(raw.hash, ""));
	const legacyMtime = toNumber(raw.lastPenDropTime, 0);
	const mtime = toNumber(raw.mtime, legacyMtime);
	const version = Math.max(0, Math.floor(toNumber(raw.version, legacyUploaded ? 1 : 0)));
	const baseVersion = Math.max(0, Math.floor(toNumber(raw.baseVersion, version)));
	const parentHash = toString(raw.parentHash, legacyUploaded === false ? "" : contentHash);

	return {
		fileId: toString(raw.fileId, path),
		version,
		baseVersion,
		contentHash,
		mtime,
		lastModifiedBy: toString(raw.lastModifiedBy, fallbackDeviceId),
		remoteRevision: typeof raw.remoteRevision === "string" ? raw.remoteRevision : undefined,
		parentHash,
		deleted: raw.deleted === true,
	};
}

export function normalizeDeletedEntry(path: string, raw: Partial<DeletedEntry>, fallbackDeviceId = ""): DeletedEntry {
	const version = Math.max(0, Math.floor(toNumber(raw.version, 0)));
	const baseVersion = Math.max(0, Math.floor(toNumber(raw.baseVersion, Math.max(0, version - 1))));
	const ackedBy = raw.ackedBy && typeof raw.ackedBy === "object"
		? raw.ackedBy as Record<string, number>
		: undefined;

	return {
		mtime: toNumber(raw.mtime, Date.now()),
		deletedBy: toString(raw.deletedBy, fallbackDeviceId),
		version,
		baseVersion,
		fileId: typeof raw.fileId === "string" ? raw.fileId : path,
		contentHash: typeof raw.contentHash === "string" ? raw.contentHash : undefined,
		remoteRevision: typeof raw.remoteRevision === "string" ? raw.remoteRevision : undefined,
		ackedBy,
	};
}

export function createLocalFileState(path: string, contentHash: string, mtime: number, deviceId: string): FileState {
	return {
		fileId: path,
		version: 0,
		baseVersion: 0,
		contentHash,
		mtime,
		lastModifiedBy: deviceId,
		parentHash: "",
	};
}

export function createSyncedFileState(path: string, state: FileState, remoteRevision?: string): FileState {
	return {
		fileId: state.fileId || path,
		version: state.version,
		baseVersion: state.version,
		contentHash: state.contentHash,
		mtime: state.mtime,
		lastModifiedBy: state.lastModifiedBy,
		remoteRevision: remoteRevision ?? state.remoteRevision,
		parentHash: state.contentHash,
	};
}

export function createDeletedEntry(
	path: string,
	deletedBy: string,
	baseVersion: number,
	fileId: string = path,
	contentHash = "",
	remoteRevision?: string,
): DeletedEntry {
	const now = Date.now();
	return {
		mtime: now,
		deletedBy,
		version: baseVersion + 1,
		baseVersion,
		fileId,
		contentHash,
		remoteRevision,
		ackedBy: {[deletedBy]: now},
	};
}

export function mergeDiskWithLedger(path: string, diskEntry: FileState, ledgerEntry: FileState | undefined, deviceId: string): FileState {
	if (!ledgerEntry) {
		return diskEntry;
	}

	const ledger = normalizeFileState(path, ledgerEntry, deviceId);
	const previousHash = ledger.contentHash || ledger.parentHash || "";
	const contentChanged = diskEntry.contentHash !== previousHash;

	return {
		...ledger,
		contentHash: diskEntry.contentHash,
		mtime: contentChanged ? diskEntry.mtime : ledger.mtime,
		lastModifiedBy: contentChanged ? deviceId : ledger.lastModifiedBy,
		parentHash: ledger.parentHash ?? previousHash,
	};
}

export function isLocalDirty(state: FileState): boolean {
	return state.deleted !== true && state.contentHash !== (state.parentHash ?? "");
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
				const bytes = new Uint8Array(await this.adapter.readBinary(filePath));
				const contentHash = await sha256Hex(bytes);
				result[normalized] = createLocalFileState(normalized, contentHash, stat.mtime, this.deviceId);
			}
		}

		for (const folder of folders) {
			if (this.isExcluded(folder)) continue;
			await this.walk(folder, result);
		}
	}
}

// ══════════════════════════════════════════════════════════
// Diff 算法（版本链 + 墓碑 + 内容哈希缝合）
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
		const normalizedLocal = local ? normalizeFileState(path, local, currentDeviceId) : undefined;
		const normalizedCloud = cloud ? normalizeFileState(path, cloud, cloudManifest?.deviceId ?? "") : undefined;
		const normalizedLocalTomb = localTomb ? normalizeDeletedEntry(path, localTomb, currentDeviceId) : undefined;
		const normalizedCloudTomb = cloudTomb ? normalizeDeletedEntry(path, cloudTomb, cloudManifest?.deviceId ?? "") : undefined;
		const normalizedLedger = ledgerEntry ? normalizeFileState(path, ledgerEntry, currentDeviceId) : undefined;

		// ── 墓碑检查（优先级最高）──

		if (normalizedLocalTomb && normalizedCloudTomb) {
			continue;
		}

		if (normalizedLocalTomb && !normalizedCloudTomb) {
			if (normalizedCloud) {
				if (normalizedLocalTomb.baseVersion === normalizedCloud.version) {
					deleteQueue.push(path);
				} else {
					conflictQueue.push(path);
				}
			}
			continue;
		}

		if (!normalizedLocalTomb && normalizedCloudTomb) {
			if (normalizedLocal) {
				if (isLocalDirty(normalizedLocal)) {
					if (normalizedLocal.baseVersion >= normalizedCloudTomb.version) {
						uploadQueue.push(path);
					} else {
						conflictQueue.push(path);
					}
				} else if (normalizedLocal.version <= normalizedCloudTomb.version) {
					localDeleteQueue.push(path);
				} else {
					conflictQueue.push(path);
				}
			}
			continue;
		}

		// ── 无墓碑：版本链判定 ──

		if (normalizedLocal && !normalizedCloud) {
			// 仅本地存在
			if (isLocalDirty(normalizedLocal) || normalizedLocal.version === 0) {
				uploadQueue.push(path);
			}
			continue;
		}

		if (!normalizedLocal && normalizedCloud) {
			// 仅云端存在 → 下载
			downloadQueue.push(path);
			continue;
		}

		if (normalizedLocal && normalizedCloud) {
			// 冷启动/换设备：同名真实 SHA-256 一致，直接编入账本。
			if (
				!normalizedLedger &&
				isTrustedContentHash(normalizedLocal.contentHash) &&
				normalizedLocal.contentHash === normalizedCloud.contentHash
			) {
				hashStitched.push(path);
				continue;
			}

			if (normalizedLocal.contentHash === normalizedCloud.contentHash) {
				if (normalizedLocal.version !== normalizedCloud.version || normalizedLocal.baseVersion !== normalizedCloud.version) {
					hashStitched.push(path);
				}
				continue;
			}

			if (isLocalDirty(normalizedLocal)) {
				if (normalizedLocal.baseVersion === normalizedCloud.version) {
					uploadQueue.push(path);
				} else {
					conflictQueue.push(path);
				}
				continue;
			}

			if (normalizedLocal.version < normalizedCloud.version) {
				downloadQueue.push(path);
			} else {
				conflictQueue.push(path);
			}
		}
	}

	return {uploadQueue, downloadQueue, deleteQueue, localDeleteQueue, conflictQueue, hashStitched};
}
