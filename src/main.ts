import {Notice, Platform, Plugin, TAbstractFile, TFile} from "obsidian";
import {DEFAULT_SETTINGS, S3BackupSettings, S3SyncSettingTab} from "./settings";
import {createDeletedEntry, createSyncedFileState, DeletedEntry, FileState, FileScanner, isSyncTargetPath as isSyncTargetPathForSettings, mergeDiskWithLedger, normalizeDeletedEntry, normalizeFileState, normalizeSyncPath, sha256Hex} from "./scanner";
import {S3TransferManager, type SyncResult} from "./transfer";
import {ConflictModal, ConflictResolution} from "./ConflictModal";

function generateDeviceId(): string {
	const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
	let id = "";
	for (let i = 0; i < 8; i++) {
		id += chars[Math.floor(Math.random() * chars.length)];
	}
	return id;
}

type SyncPhase = "idle" | "scanning" | "uploading" | "downloading" | "deleting" | "done";

const DEBOUNCE_MS = 3000;
const SUPPRESS_PATH_RELEASE_MS = 1500;
const MANIFEST_REBASE_MAX_ATTEMPTS = 3;
const MANIFEST_REBASE_MIN_BACKOFF_MS = 300;
const MANIFEST_REBASE_MAX_BACKOFF_MS = 1000;

export default class S3SyncPlugin extends Plugin {
	settings: S3BackupSettings;
	private _syncing = false;
	public isSyncing = false;
	private syncTimeout: number | null = null;
	private autoSyncTimer: number | null = null;
	private localLastSyncTime = 0;
	private statusBarItem: HTMLElement | null = null;
	private transferManager: S3TransferManager | null = null;
	private pendingPaths: Set<string> = new Set();
	private suppressPaths: Set<string> = new Set();
	private suppressTimers: Map<string, number> = new Map();
	private suppressExpectedHashes: Map<string, string> = new Map();
	private failedPathBackoff: Map<string, { lastFailedAt: number; count: number; nextRetryAt: number }> = new Map();

	// ── 状态栏倒计时相关 ──
	private nextAutoSyncAt = 0;
	private nextDebouncedSyncAt = 0;
	private statusCountdownTimer: number | null = null;
	private currentStatusPhase: SyncPhase = "idle";
	private doneStatusResetTimer: number | null = null;

	// ── 观察者账本：内存级本地文件状态快照 ──
	public localLedger: Record<string, FileState> = {};

	// ── 内存级同步墓碑：纯同步赋值，杜绝竞态覆盖 ──
	public localTombstones: Record<string, DeletedEntry> = {};

	async onload() {
		await this.loadSettings();

		if (!this.settings.deviceId) {
			this.settings.deviceId = generateDeviceId();
			await this.saveSettings();
		}

		// 加载本地观察者账本
		this.localLedger = this.loadLedger();

		// 加载本地墓碑记录
		this.localTombstones = this.loadTombstones();

		// 加载本地 Pending 路径
		this.pendingPaths = this.loadPendingPaths();
		this.sanitizePersistedState();

		// 读取本地上次同步时间戳
		const storedTime = this.app.loadLocalStorage("s3-sync-last-sync-time");
		this.localLastSyncTime = storedTime ? parseInt(storedTime, 10) : 0;

		// ── 启动核对：用真实内容哈希检测 Obsidian 关闭期间的外部修改 ──
		await this.detectExternalModifications();

		// Ribbon 图标
		this.addRibbonIcon("refresh-cw", "S3 Sync", () => {
			this.startSync();
		});

		// 命令面板
		this.addCommand({
			id: "s3-sync-now",
			name: "同步到 S3",
			callback: () => this.startSync(),
		});

		// 设置页
		this.addSettingTab(new S3SyncSettingTab(this.app, this));

		// 状态栏
		this.statusBarItem = this.addStatusBarItem();
		this.updateStatusBar("idle");
		this.startStatusCountdownTimer();

		// 定时自动同步
		this.setupAutoSync();

		// 视口焦点事件：前台获得焦点时尝试同步
		this.registerDomEvent(window, "focus", () => {
			if (this.settings.autoSync && !this.isSyncing) {
				console.log("[S3 Sync] 窗口获得焦点，触发自动静默同步");
				this.startSync(true);
			}
		});

		// 视口隐藏事件：应用进入后台时立即 flush 本地账本并开始同步 pending
		this.registerDomEvent(document, "visibilitychange", () => {
			if (document.hidden) {
				this.persistLedger();
				this.persistTombstones();
				this.persistPendingPaths();
				if (this.settings.autoSync && this.pendingPaths.size > 0) {
					console.log("[S3 Sync] 应用进入后台，立即同步 pending 文件");
					const paths = [...this.pendingPaths];
					this.startSync(true, paths);
				}
			}
		});

		// ── 观察者事件 ──
		this.registerEvent(this.app.vault.on("modify", (file) => this.onFileModify(file)));
		this.registerEvent(this.app.vault.on("create", (file) => this.onFileCreate(file)));
		this.registerEvent(this.app.vault.on("delete", (file) => this.onFileDelete(file)));
		// ── 任务二：重命名/移动拦截器 ──
		this.registerEvent(this.app.vault.on("rename", (file, oldPath) => this.onFileRename(file, oldPath)));
	}

	// ── 冲突处理 ──

	private async resolveConflicts(conflictPaths: string[]): Promise<void> {
		if (!this.transferManager) return;

		const cloudManifest = await this.transferManager.fetchCloudManifest();
		const cloudFiles = cloudManifest?.files ?? {};

		for (const path of conflictPaths) {
			if (Platform.isDesktop) {
				// 桌面端：弹窗让用户选择
				const resolution = await this.showConflictModal(path, cloudFiles);
				await this.applyConflictResolution(path, resolution, cloudFiles);
			} else {
				// 移动端：自动生成冲突副本
				await this.applyConflictResolution(path, "both", cloudFiles);
			}
		}
	}

	private showConflictModal(
		path: string,
		cloudFiles: Record<string, FileState>,
	): Promise<ConflictResolution> {
		return new Promise((resolve) => {
			const cloudEntry = cloudFiles[path];
			new ConflictModal(
				this.app,
				path,
				this.settings.deviceName,
				cloudEntry?.lastModifiedBy ?? "unknown",
				this.localLedger[path]?.mtime ?? 0,
				cloudEntry?.mtime ?? 0,
				resolve,
			).open();
		});
	}

	private async applyConflictResolution(
		path: string,
		resolution: ConflictResolution,
		cloudFiles: Record<string, FileState>,
	): Promise<void> {
		if (!this.transferManager) return;
		const cloudEntry = cloudFiles[path];
		if (!cloudEntry) return;

		const normalizedCloud = normalizeFileState(path, cloudEntry, this.settings.deviceId);

		if (resolution === "local") {
			console.log("[S3 Sync] 冲突解决：保留本地版本", path);
			const ledgerEntry = this.localLedger[path];
			if (ledgerEntry) {
				this.localLedger[path] = {
					...ledgerEntry,
					baseVersion: normalizedCloud.version,
					parentHash: normalizedCloud.contentHash,
				};
				this.persistLedger();
				this.pendingPaths.add(path);
				this.persistPendingPaths();
				this.triggerDebouncedSync();
			}
		} else if (resolution === "cloud") {
			console.log("[S3 Sync] 冲突解决：使用云端版本", path);
			try {
				const written = await this.transferManager.downloadAndWriteFile(
					path,
					normalizedCloud.objectKey,
					undefined,
					normalizedCloud.contentHash
				);
				this.localLedger[path] = createSyncedFileState(path, {
					...normalizedCloud,
					contentHash: written.contentHash,
					mtime: written.mtime ?? normalizedCloud.mtime,
					remoteRevision: written.remoteRevision ?? normalizedCloud.remoteRevision,
				}, written.remoteRevision);
				this.persistLedger();
			} catch (err) {
				console.error("[S3 Sync] 冲突解决：下载云端版本失败", path, err);
			}
		} else if (resolution === "both") {
			console.log("[S3 Sync] 冲突解决：保留双份副本", path);
			try {
				const timestamp = new Date().toISOString().replace(/T/, "-").replace(/\..+/, "").replace(/:/g, "-");
				const deviceName = cloudEntry.lastModifiedBy || "unknown";
				const dotIdx = path.lastIndexOf(".");
				const ext = dotIdx >= 0 ? path.slice(dotIdx) : "";
				const base = dotIdx >= 0 ? path.slice(0, dotIdx) : path;
				const conflictPath = `${base}.conflict-${deviceName}-${timestamp}${ext}`;

				// 直接将云端内容下载到冲突副本路径下
				await this.transferManager.downloadAndWriteFile(
					path,
					normalizedCloud.objectKey,
					conflictPath,
					normalizedCloud.contentHash
				);

				// 解决主路径冲突：将本地主路径标记为赢家
				const ledgerEntry = this.localLedger[path];
				if (ledgerEntry) {
					this.localLedger[path] = {
						...ledgerEntry,
						baseVersion: normalizedCloud.version,
						parentHash: normalizedCloud.contentHash,
					};
					this.persistLedger();
				}
				this.pendingPaths.add(path);
				this.pendingPaths.add(conflictPath);
				this.persistPendingPaths();
				
				new Notice(`已保存冲突副本：${conflictPath}`);
				this.triggerDebouncedSync();
			} catch (err) {
				console.error("[S3 Sync] 冲突解决：生成冲突副本失败", path, err);
			}
		}
	}

	onunload() {
		if (this.syncTimeout !== null) {
			window.clearTimeout(this.syncTimeout);
			this.syncTimeout = null;
		}
		if (this.autoSyncTimer !== null) {
			window.clearInterval(this.autoSyncTimer);
			this.autoSyncTimer = null;
		}
		if (this.statusCountdownTimer !== null) {
			window.clearInterval(this.statusCountdownTimer);
			this.statusCountdownTimer = null;
		}
		if (this.doneStatusResetTimer !== null) {
			window.clearTimeout(this.doneStatusResetTimer);
			this.doneStatusResetTimer = null;
		}
		for (const timer of this.suppressTimers.values()) {
			clearTimeout(timer);
		}
		this.suppressTimers.clear();
		this.suppressPaths.clear();
		this.suppressExpectedHashes.clear();
	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData() as Partial<S3BackupSettings>);
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}

	// ══════════════════════════════════════════════════════════
	// 启动核对 — 检测外部修改的灯下黑
	// ══════════════════════════════════════════════════════════

	private async detectExternalModifications(): Promise<void> {
		const scanner = new FileScanner(this.app.vault.adapter, this.settings);
		const diskFiles = await scanner.scanAll();
		let dirtyCount = 0;

		for (const [path, diskEntry] of Object.entries(diskFiles)) {
			const ledgerEntry = this.localLedger[path];

			if (!ledgerEntry) {
				// 账本无记录 → 新文件或冷启动，默认基于版本 0
				this.localLedger[path] = diskEntry;
				dirtyCount++;
				continue;
			}

			const merged = mergeDiskWithLedger(path, diskEntry, ledgerEntry, this.settings.deviceId);
			const previous = normalizeFileState(path, ledgerEntry, this.settings.deviceId);
			if (merged.contentHash !== previous.contentHash) {
				this.localLedger[path] = merged;
				dirtyCount++;
				console.log("[S3 Sync] 启动核对：检测到外部修改", path, "baseVersion", merged.baseVersion);
			}
		}

		// 清理账本中磁盘已不存在的条目 → 生成墓碑防止复活
		let deletedCount = 0;
		for (const path of Object.keys(this.localLedger)) {
			if (!diskFiles[path]) {
				const ledgerEntry = this.localLedger[path]!;
				const normalized = normalizeFileState(path, ledgerEntry, this.settings.deviceId);
				this.localTombstones[path] = createDeletedEntry(
					path,
					this.settings.deviceId,
					normalized.version,
					normalized.fileId || path,
					normalized.contentHash,
					normalized.remoteRevision,
				);
				delete this.localLedger[path];
				deletedCount++;
			}
		}

		if (deletedCount > 0 || dirtyCount > 0) {
			console.log("[S3 Sync] 启动核对：发现外部修改或删除，持久化并触发同步", { deletedCount, dirtyCount });
			this.persistLedger();
			this.persistTombstones();
			this.triggerDebouncedSync();
		} else {
			console.log("[S3 Sync] 启动核对完成：账本与磁盘一致，无外部修改");
		}
	}

	// ══════════════════════════════════════════════════════════
	// 任务二：重命名/移动拦截器
	// ══════════════════════════════════════════════════════════

	private onFileRename(file: TAbstractFile, oldPath: string): void {
		if (!(file instanceof TFile)) return;

		const newPath = file.path;
		const shouldSyncOld = this.isSyncTargetPath(oldPath);
		const shouldSyncNew = this.isSyncTargetPath(newPath);
		if (!shouldSyncOld && !shouldSyncNew) return;

		if (shouldSyncOld && !shouldSyncNew) {
			this.onFileDeleteByPath(oldPath);
			this.triggerDebouncedSync();
			return;
		}

		if (!shouldSyncNew) return;

		// 1. 将旧路径的账本记录转移给新路径，并为旧路径保留删除墓碑
		const oldEntry = shouldSyncOld ? this.localLedger[oldPath] : undefined;
		if (oldEntry && shouldSyncOld) {
			const normalizedOld = normalizeFileState(oldPath, oldEntry, this.settings.deviceId);
			this.localLedger[newPath] = {
				...normalizedOld,
				fileId: normalizedOld.fileId || oldPath,
				parentHash: "",
				mtime: Date.now(),
				lastModifiedBy: this.settings.deviceId,
			};
			delete this.localLedger[oldPath];
			this.localTombstones[oldPath] = createDeletedEntry(
				oldPath,
				this.settings.deviceId,
				normalizedOld.version,
				normalizedOld.fileId,
				normalizedOld.contentHash,
				normalizedOld.remoteRevision,
			);
			this.pendingPaths.delete(oldPath);
			console.log("[S3 Sync] 重命名拦截：账本转移", oldPath, "→", newPath);
		} else {
			// 旧路径无账本记录（可能是外部创建的文件），新建条目
			const oldTomb = this.localTombstones[newPath]
				? normalizeDeletedEntry(newPath, this.localTombstones[newPath], this.settings.deviceId)
				: undefined;
			this.localLedger[newPath] = {
				fileId: newPath,
				version: oldTomb?.version ?? 0,
				baseVersion: oldTomb?.version ?? 0,
				contentHash: "",
				mtime: Date.now(),
				lastModifiedBy: this.settings.deviceId,
				parentHash: oldTomb?.contentHash ?? "",
			};
			console.log("[S3 Sync] 重命名拦截：新建账本", newPath);
		}

		// 立即持久化，不等防抖
		this.persistLedger();
		this.persistTombstones();
		this.pendingPaths.add(newPath);
		this.persistPendingPaths();
		this.triggerDebouncedSync();
	}

	// ══════════════════════════════════════════════════════════
	// 观察者事件：文件修改/新建 → 纯同步内存更新账本
	// ══════════════════════════════════════════════════════════

	private onFileModify(file: TAbstractFile): void {
		if (!(file instanceof TFile)) return;
		if (!this.isSyncTargetPath(file.path)) return;
		if (this.isSuppressedPath(file.path)) {
			void this.handleSuppressedFileModify(file);
			return;
		}

		this.recordFileModify(file);
	}

	private async handleSuppressedFileModify(file: TFile): Promise<void> {
		if (await this.isSyncWriteEcho(file.path)) return;
		this.recordFileModify(file);
	}

	private recordFileModify(file: TFile): void {
		const existingEntry = this.localLedger[file.path];
		const tombstoneEntry = this.localTombstones[file.path];
		const existing = existingEntry
			? normalizeFileState(file.path, existingEntry, this.settings.deviceId)
			: undefined;
		const tombstone = tombstoneEntry
			? normalizeDeletedEntry(file.path, tombstoneEntry, this.settings.deviceId)
			: undefined;

		// 纯同步内存赋值 — 内容哈希稍后由扫描器补齐，baseVersion 保留最后看到的云端版本
		const updatedEntry: FileState = {
			fileId: existing?.fileId ?? tombstone?.fileId ?? file.path,
			version: existing?.version ?? tombstone?.version ?? 0,
			baseVersion: existing?.version ?? tombstone?.version ?? 0,
			contentHash: existing?.contentHash ?? "",
			mtime: Date.now(),
			lastModifiedBy: this.settings.deviceId,
			remoteRevision: existing?.remoteRevision ?? tombstone?.remoteRevision,
			parentHash: existing?.contentHash ?? tombstone?.contentHash ?? "",
		};
		this.localLedger[file.path] = updatedEntry;
		if (this.localTombstones[file.path]) {
			delete this.localTombstones[file.path];
		}
		console.log("[S3 Sync] 观察者：落笔记录", file.path, "baseVersion", updatedEntry.baseVersion);

		// 立即持久化，不等防抖 — Android 后台时至少保证修改事实落盘
		this.persistLedger();
		this.persistTombstones();
		this.pendingPaths.add(file.path);
		this.persistPendingPaths();
		this.triggerDebouncedSync();
	}

	private onFileCreate(file: TAbstractFile): void {
		this.onFileModify(file);
	}

	// ── 文件删除拦截 → 纯同步内存赋值墓碑 ──

	private onFileDelete(file: TAbstractFile): void {
		if (!(file instanceof TFile)) return;
		if (this.isSuppressedPath(file.path)) {
			const normalized = normalizeSyncPath(file.path);
			// 下载写入后的短暂 suppress 窗口仍有 expected hash；若此时收到 delete，
			// 更可能是用户真实删除，而不是同步引擎的 remove 回声。
			if (!this.suppressExpectedHashes.has(normalized)) return;
			this.clearSuppressPath(file.path);
		}
		this.onFileDeleteByPath(file.path);
		this.triggerDebouncedSync();
	}

	private onFileDeleteByPath(path: string): void {
		if (!this.isSyncTargetPath(path)) return;

		const oldLedgerEntry = this.localLedger[path];
		const oldEntry = oldLedgerEntry
			? normalizeFileState(path, oldLedgerEntry, this.settings.deviceId)
			: undefined;
		const baseVersion = oldEntry?.version ?? 0;
		this.localTombstones[path] = createDeletedEntry(
			path,
			this.settings.deviceId,
			baseVersion,
			oldEntry?.fileId ?? path,
			oldEntry?.contentHash ?? "",
			oldEntry?.remoteRevision,
		);
		delete this.localLedger[path];
		console.log("[S3 Sync] 观察者：记录墓碑", path, "baseVersion", baseVersion);

		// 立即持久化，不等防抖 — Android 后台时至少保证删除事实落盘
		this.persistLedger();
		this.persistTombstones();
		this.pendingPaths.add(path);
		this.persistPendingPaths();
	}

	private isSyncTargetPath(path: string): boolean {
		return isSyncTargetPathForSettings(path, this.settings);
	}

	private isSuppressedPath(path: string): boolean {
		return this.suppressPaths.has(normalizeSyncPath(path));
	}

	private clearSuppressPath(path: string): void {
		const normalized = normalizeSyncPath(path);
		const existingTimer = this.suppressTimers.get(normalized);
		if (existingTimer !== undefined) {
			clearTimeout(existingTimer);
		}
		this.suppressTimers.delete(normalized);
		this.suppressPaths.delete(normalized);
		this.suppressExpectedHashes.delete(normalized);
	}

	private beginSuppressPath(path: string): void {
		const normalized = normalizeSyncPath(path);
		const existingTimer = this.suppressTimers.get(normalized);
		if (existingTimer !== undefined) {
			clearTimeout(existingTimer);
			this.suppressTimers.delete(normalized);
		}
		this.suppressPaths.add(normalized);
		this.suppressExpectedHashes.delete(normalized);
	}

	private endSuppressPath(path: string, contentHash?: string): void {
		const normalized = normalizeSyncPath(path);
		const existingTimer = this.suppressTimers.get(normalized);
		if (existingTimer !== undefined) {
			clearTimeout(existingTimer);
		}
		if (contentHash) {
			this.suppressExpectedHashes.set(normalized, contentHash);
		} else {
			this.suppressExpectedHashes.delete(normalized);
		}
		const timer = setTimeout(() => {
			this.suppressPaths.delete(normalized);
			this.suppressTimers.delete(normalized);
			this.suppressExpectedHashes.delete(normalized);
		}, SUPPRESS_PATH_RELEASE_MS) as unknown as number;
		this.suppressTimers.set(normalized, timer);
	}

	private async isSyncWriteEcho(path: string): Promise<boolean> {
		const normalized = normalizeSyncPath(path);
		if (!this.suppressPaths.has(normalized)) return false;

		const expectedHash = this.suppressExpectedHashes.get(normalized);
		if (!expectedHash) return true;

		try {
			if (!(await this.app.vault.adapter.exists(path))) return true;
			const bytes = new Uint8Array(await this.app.vault.adapter.readBinary(path));
			const currentHash = await sha256Hex(bytes);
			if (currentHash === expectedHash) return true;

			console.warn("[S3 Sync] suppress 窗口内检测到真实用户修改，保留 pending：", path);
			this.clearSuppressPath(path);
			return false;
		} catch (err) {
			console.warn("[S3 Sync] 无法校验 suppress 回声，按同步写入事件忽略：", path, err);
			return true;
		}
	}

	private sanitizePersistedState(): void {
		let changed = false;

		for (const path of Object.keys(this.localLedger)) {
			if (!this.isSyncTargetPath(path)) {
				delete this.localLedger[path];
				changed = true;
			}
		}

		for (const path of Object.keys(this.localTombstones)) {
			if (!this.isSyncTargetPath(path)) {
				delete this.localTombstones[path];
				changed = true;
			}
		}

		for (const path of [...this.pendingPaths]) {
			if (!this.isSyncTargetPath(path)) {
				this.pendingPaths.delete(path);
				changed = true;
			}
		}

		if (changed) {
			console.log("[S3 Sync] 已清理持久化状态中的非同步目标路径");
			this.persistLedger();
			this.persistTombstones();
			this.persistPendingPaths();
		}
	}

	// ══════════════════════════════════════════════════════════
	// 墓碑垃圾回收 (Tombstone GC)
	// ══════════════════════════════════════════════════════════

	public runTombstoneGC(tombstones: Record<string, DeletedEntry>): Record<string, DeletedEntry> {
		const result: Record<string, DeletedEntry> = {};

		for (const [path, entry] of Object.entries(tombstones)) {
			result[path] = normalizeDeletedEntry(path, entry, this.settings?.deviceId ?? "");
		}

		return result;
	}

	// ── 全局防抖器 ──

	private triggerDebouncedSync(): void {
		const {accessKey, secretKey, endpoint, bucketName} = this.settings;
		if (!accessKey || !secretKey || !endpoint || !bucketName) return;

		if (this.syncTimeout !== null) {
			window.clearTimeout(this.syncTimeout);
		}

		this.nextDebouncedSyncAt = Date.now() + DEBOUNCE_MS;

		this.syncTimeout = window.setTimeout(() => {
			this.syncTimeout = null;
			this.nextDebouncedSyncAt = 0;
			console.log("[S3 Sync] 全局防抖触发：3 秒无新操作，开始同步");

			// 1. 持久化内存账本和墓碑
			this.persistLedger();
			this.persistTombstones();

			// 2. 收集 pending 路径，等待 manifest 成功提交后再清除
			const paths = [...this.pendingPaths];

			// 3. 执行增量同步
			this.startSync(true, paths);
		}, DEBOUNCE_MS);
	}

	// ── 账本持久化 ──

	private loadLedger(): Record<string, FileState> {
		const raw = this.app.loadLocalStorage("s3-sync-ledger");
		if (!raw) return {};
		try {
			return JSON.parse(raw) as Record<string, FileState>;
		} catch {
			return {};
		}
	}

	private persistLedger(): void {
		this.app.saveLocalStorage("s3-sync-ledger", JSON.stringify(this.localLedger));
	}

	// ── 墓碑持久化 ──

	private loadTombstones(): Record<string, DeletedEntry> {
		const raw = this.app.loadLocalStorage("s3-sync-tombstones");
		if (!raw) return {};
		try {
			return JSON.parse(raw) as Record<string, DeletedEntry>;
		} catch {
			return {};
		}
	}

	private persistTombstones(): void {
		// 墓碑长期保留，避免超过固定时间未上线的设备复活旧文件。
		this.localTombstones = this.runTombstoneGC(this.localTombstones);
		this.app.saveLocalStorage("s3-sync-tombstones", JSON.stringify(this.localTombstones));
	}

	private loadPendingPaths(): Set<string> {
		const raw = this.app.loadLocalStorage("s3-sync-pending-paths");
		if (!raw) return new Set();
		try {
			return new Set((JSON.parse(raw) as string[]).map(path => normalizeSyncPath(path)));
		} catch {
			return new Set();
		}
	}

	private persistPendingPaths(): void {
		this.app.saveLocalStorage("s3-sync-pending-paths", JSON.stringify([...this.pendingPaths]));
	}

	// ── 状态栏 ──

	private formatCountdown(targetAt: number): string {
		const remaining = Math.max(0, Math.ceil((targetAt - Date.now()) / 1000));
		const m = Math.floor(remaining / 60);
		const s = remaining % 60;
		return `${m}:${String(s).padStart(2, "0")}`;
	}

	private getIdleStatusText(): string {
		if (this.nextDebouncedSyncAt > Date.now()) {
			return `☁ 就绪 · 待同步 ${this.formatCountdown(this.nextDebouncedSyncAt)}`;
		}
		if (this.settings.autoSync && Platform.isDesktop && this.nextAutoSyncAt > Date.now()) {
			return `☁ 就绪 · 下次 ${this.formatCountdown(this.nextAutoSyncAt)}`;
		}
		return "☁ 就绪";
	}

	private startStatusCountdownTimer(): void {
		if (this.statusCountdownTimer !== null) {
			window.clearInterval(this.statusCountdownTimer);
			this.statusCountdownTimer = null;
		}
		this.statusCountdownTimer = window.setInterval(() => {
			if (this.currentStatusPhase === "idle" && this.statusBarItem) {
				this.statusBarItem.setText(this.getIdleStatusText());
			}
		}, 1000) as unknown as number;
	}

	private updateStatusBar(phase: SyncPhase, progress?: { done: number; total: number }): void {
		if (!this.statusBarItem) return;

		// 清理旧的 done 重置定时器，防止覆盖新状态
		if (this.doneStatusResetTimer !== null) {
			window.clearTimeout(this.doneStatusResetTimer);
			this.doneStatusResetTimer = null;
		}

		this.currentStatusPhase = phase;

		switch (phase) {
			case "idle":
				this.statusBarItem.setText(this.getIdleStatusText());
				break;
			case "scanning":
				this.statusBarItem.setText("🔄 扫描中…");
				break;
			case "uploading":
				this.statusBarItem.setText(`🔄 上传中 (${progress?.done ?? 0}/${progress?.total ?? 0})`);
				break;
			case "downloading":
				this.statusBarItem.setText(`🔄 下载中 (${progress?.done ?? 0}/${progress?.total ?? 0})`);
				break;
			case "deleting":
				this.statusBarItem.setText(`🔄 删除中 (${progress?.done ?? 0}/${progress?.total ?? 0})`);
				break;
			case "done":
				this.statusBarItem.setText("✅ 同步完成");
				this.doneStatusResetTimer = window.setTimeout(() => {
					this.doneStatusResetTimer = null;
					this.updateStatusBar("idle");
				}, 3000) as unknown as number;
				break;
		}
	}

	// ── 定时自动同步 ──

	setupAutoSync(): void {
		// 清除现有定时器
		if (this.autoSyncTimer !== null) {
			window.clearInterval(this.autoSyncTimer);
			this.autoSyncTimer = null;
		}
		this.nextAutoSyncAt = 0;

		if (!this.settings.autoSync) return;

		const intervalMs = this.settings.syncInterval * 60 * 1000;

		if (Platform.isDesktop) {
			this.nextAutoSyncAt = Date.now() + intervalMs;
			this.autoSyncTimer = window.setInterval(() => {
				console.log("[S3 Sync] 自动同步触发，间隔：", this.settings.syncInterval, "分钟");
				this.nextAutoSyncAt = Date.now() + intervalMs;
				this.startSync(true);
			}, intervalMs);
			this.registerInterval(this.autoSyncTimer);
		}
		// 移动端不依赖长定时器（Android 会杀后台定时器），通过文件事件防抖同步
	}

	// ── 同步入口 ──

	private isManifestPreconditionFailure(result: SyncResult): boolean {
		return result.failed.some(item => {
			if (item.path !== "manifest.json") return false;
			return /precondition|412|if-?match|if-?none-?match|条件写入|条件/i.test(item.error);
		});
	}

	private async waitForManifestRebaseBackoff(): Promise<void> {
		const jitter = MANIFEST_REBASE_MIN_BACKOFF_MS
			+ Math.floor(Math.random() * (MANIFEST_REBASE_MAX_BACKOFF_MS - MANIFEST_REBASE_MIN_BACKOFF_MS + 1));
		await new Promise<void>(resolve => window.setTimeout(resolve, jitter));
	}

	private async startSync(silent = false, pendingPaths?: string[]): Promise<void> {
		if (this._syncing) {
			if (!silent) new Notice("同步正在进行中，请稍候…");
			return;
		}

		const {accessKey, secretKey, endpoint, bucketName} = this.settings;
		if (!accessKey || !secretKey || !endpoint || !bucketName) {
			if (!silent) new Notice("请先在设置中填写完整的 S3 配置");
			return;
		}

		if (!silent) {
			this.failedPathBackoff.clear();
		}

		const ignoredPaths = new Set<string>();
		const now = Date.now();
		if (silent) {
			for (const [path, backoff] of this.failedPathBackoff.entries()) {
				if (now < backoff.nextRetryAt) {
					ignoredPaths.add(path);
				}
			}
		}

		this._syncing = true;
		this.isSyncing = true;
		this.updateStatusBar("scanning");

		if (!silent) new Notice("S3 同步开始…");

		const pendingSnapshot = pendingPaths ?? [...this.pendingPaths];
		const shouldQuickSync = (pendingPaths != null && pendingPaths.length > 0)
			|| (silent && pendingSnapshot.length > 0);

		try {
			const onProgress = (done: number, total: number, mode: "upload" | "download" | "delete") => {
				const phase = mode === "upload" ? "uploading" : mode === "download" ? "downloading" : "deleting";
				this.updateStatusBar(phase, {done, total});
			};

			const runTransferAttempt = async (): Promise<SyncResult> => {
				this.transferManager = new S3TransferManager(this.app.vault, this.settings, {
					beginPathWrite: (path) => this.beginSuppressPath(path),
					endPathWrite: (path, contentHash) => this.endSuppressPath(path, contentHash),
				});
				if (shouldQuickSync) {
					return this.transferManager.quickSync(
						this.settings.deviceId,
						this.localLastSyncTime,
						3000,
						this.localTombstones,
						this.localLedger,
						pendingSnapshot.filter(p => !ignoredPaths.has(p)),
						!silent,
					);
				}
				return this.transferManager.fullSync(
					this.settings.deviceId,
					this.localLastSyncTime,
					onProgress,
					this.localTombstones,
					this.localLedger,
					!silent,
					ignoredPaths,
				);
			};

			let result = await runTransferAttempt();
			for (let attempt = 2; attempt <= MANIFEST_REBASE_MAX_ATTEMPTS && this.isManifestPreconditionFailure(result); attempt++) {
				console.warn("[S3 Sync] manifest 条件写入冲突，重新拉取云端 manifest 后重试", attempt, "/", MANIFEST_REBASE_MAX_ATTEMPTS);
				await this.waitForManifestRebaseBackoff();
				result = await runTransferAttempt();
			}

			const newNow = Date.now();
			if (result.failed.length > 0) {
				for (const failed of result.failed) {
					if (failed.path === "manifest.json") continue;
					const prev = this.failedPathBackoff.get(failed.path) || { count: 0, lastFailedAt: 0, nextRetryAt: 0 };
					prev.count++;
					prev.lastFailedAt = newNow;
					
					let delay = 0;
					if (prev.count === 1) delay = 30 * 1000;
					else if (prev.count === 2) delay = 120 * 1000;
					else if (prev.count === 3) delay = 600 * 1000;
					else delay = 3600 * 1000;
					
					if (failed.error.includes("Failed to construct 'Headers'") || failed.error.includes("non ISO-8859-1")) {
						if (!silent && prev.count <= 2) {
							new Notice(`文件 ${failed.path} 上传失败，可能是文件名包含非ASCII字符`);
						}
					}
					prev.nextRetryAt = newNow + delay;
					this.failedPathBackoff.set(failed.path, prev);
				}
			}

			const manifestFailed = result.failed.some(item => item.path === "manifest.json");
			if (!manifestFailed) {
				// manifest 条件写入成功后，才把本轮同步结果视为本地账本事实。
				const completedManager = this.transferManager;
				if (!completedManager) {
					throw new Error("同步管理器未初始化");
				}
				const ledgerBeforeAdoption = this.localLedger;
				const failedPaths = new Set(result.failed.map(item => item.path));
				
				for (const path of pendingSnapshot) {
					if (!failedPaths.has(path) && !ignoredPaths.has(path)) {
						this.failedPathBackoff.delete(path);
					}
				}

				const conflictPaths = new Set(result.conflicts);
				const retainedPendingPaths = new Set(this.pendingPaths);
				for (const path of pendingSnapshot) {
					if (!failedPaths.has(path) && !conflictPaths.has(path) && !ignoredPaths.has(path)) {
						retainedPendingPaths.delete(path);
					}
				}
				const nextLedger = {...completedManager.localManifest};
				for (const path of new Set([...retainedPendingPaths, ...conflictPaths])) {
					const pendingLedger = ledgerBeforeAdoption[path];
					if (pendingLedger) {
						nextLedger[path] = pendingLedger;
					} else if (this.localTombstones[path]) {
						delete nextLedger[path];
					}
				}
				this.localLedger = nextLedger;
				this.pendingPaths = retainedPendingPaths;
				this.persistLedger();
				this.persistPendingPaths();

				this.localLastSyncTime = Date.now();
				this.app.saveLocalStorage("s3-sync-last-sync-time", String(this.localLastSyncTime));
				this.persistTombstones();
			} else {
				console.warn("[S3 Sync] manifest 未提交成功，本地账本保持原状，等待下次同步重试");
			}

			// 冲突处理
			if (result.conflicts.length > 0) {
				await this.resolveConflicts(result.conflicts);
			}

			this.updateStatusBar("done");

			if (!silent) {
				const lines: string[] = [];
				if (result.uploaded > 0) lines.push(`上传 ${result.uploaded} 个文件`);
				if (result.downloaded > 0) lines.push(`下载 ${result.downloaded} 个文件`);
				if (result.deleted > 0) lines.push(`删除 ${result.deleted} 个云端文件`);
				if (result.localDeleted > 0) lines.push(`删除 ${result.localDeleted} 个本地文件`);
				if (result.orphanCleaned > 0) lines.push(`清理 ${result.orphanCleaned} 个云端孤儿文件`);
				if (result.failed.length > 0) lines.push(`${result.failed.length} 个文件失败`);
				if (result.conflicts.length > 0) lines.push(`${result.conflicts.length} 个冲突待处理`);

				if (lines.length === 0) {
					new Notice("同步完成，所有文件已是最新");
				} else {
					new Notice(`同步完成：${lines.join("，")}`);
				}
			}

			if (result.failed.length > 0) {
				console.warn("[S3 Sync] 失败文件：", result.failed);
			}
		} catch (err: unknown) {
			const msg = err instanceof Error ? err.message : String(err);
			if (!silent) new Notice(`同步出错：${msg}`, 8000);
			this.updateStatusBar("idle");
		} finally {
			this._syncing = false;
			this.isSyncing = false;
		}
	}
}
