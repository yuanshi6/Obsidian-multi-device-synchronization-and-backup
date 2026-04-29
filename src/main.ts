import {Notice, Plugin, TAbstractFile, TFile} from "obsidian";
import {DEFAULT_SETTINGS, S3BackupSettings, S3SyncSettingTab} from "./settings";
import {createDeletedEntry, DeletedEntry, FileState, FileScanner, mergeDiskWithLedger, normalizeDeletedEntry, normalizeFileState} from "./scanner";
import {S3TransferManager} from "./transfer";

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

export default class S3SyncPlugin extends Plugin {
	settings: S3BackupSettings;
	private _syncing = false;
	public isSyncing = false;
	private syncTimeout: number | null = null;
	private localLastSyncTime = 0;
	private statusBarItem: HTMLElement | null = null;
	private transferManager: S3TransferManager | null = null;

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

		// 定时自动同步
		this.setupAutoSync();

		// ── 观察者事件 ──
		this.registerEvent(this.app.vault.on("modify", (file) => this.onFileModify(file)));
		this.registerEvent(this.app.vault.on("create", (file) => this.onFileCreate(file)));
		this.registerEvent(this.app.vault.on("delete", (file) => this.onFileDelete(file)));
		// ── 任务二：重命名/移动拦截器 ──
		this.registerEvent(this.app.vault.on("rename", (file, oldPath) => this.onFileRename(file, oldPath)));
	}

	onunload() {
		if (this.syncTimeout !== null) {
			window.clearTimeout(this.syncTimeout);
			this.syncTimeout = null;
		}
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

		// 清理账本中磁盘已不存在的条目
		for (const path of Object.keys(this.localLedger)) {
			if (!diskFiles[path]) {
				delete this.localLedger[path];
			}
		}

		if (dirtyCount > 0) {
			console.log("[S3 Sync] 启动核对完成：发现", dirtyCount, "个外部修改/新增文件");
			this.persistLedger();
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

		// 1. 将旧路径的账本记录转移给新路径，并为旧路径保留删除墓碑
		const oldEntry = this.localLedger[oldPath];
		if (oldEntry) {
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

		this.triggerDebouncedSync();
	}

	// ══════════════════════════════════════════════════════════
	// 观察者事件：文件修改/新建 → 纯同步内存更新账本
	// ══════════════════════════════════════════════════════════

	private onFileModify(file: TAbstractFile): void {
		if (this.isSyncing) return; // 忽略同步引擎自己产生的文件 I/O
		if (!(file instanceof TFile)) return;
		if (this.isPathExcluded(file.path)) return;

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

		this.triggerDebouncedSync();
	}

	private onFileCreate(file: TAbstractFile): void {
		if (this.isSyncing) return; // 忽略同步引擎自己产生的文件 I/O
		this.onFileModify(file);
	}

	// ── 文件删除拦截 → 纯同步内存赋值墓碑 ──

	private isPathExcluded(path: string): boolean {
		const patterns = this.settings.excludePatterns;
		if (!patterns) return false;
		const parts = patterns.split(",").map(p => p.trim()).filter(p => p.length > 0);
		for (const pattern of parts) {
			const escaped = pattern
				.replace(/[.+^${}()|[\]\\]/g, "\\$&")
				.replace(/\*/g, ".*")
				.replace(/\?/g, ".");
			const regex = new RegExp(`(?:^|/)${escaped}(?:/|$)`);
			if (regex.test(path)) return true;
		}
		return false;
	}

	private onFileDelete(file: TAbstractFile): void {
		if (this.isSyncing) return; // 忽略同步引擎自己产生的文件 I/O
		if (!(file instanceof TFile)) return;
		this.onFileDeleteByPath(file.path);
		this.triggerDebouncedSync();
	}

	private onFileDeleteByPath(path: string): void {
		if (!path.endsWith(".md")) return;
		if (this.isPathExcluded(path)) return;

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
		// 同时从账本中移除该文件
		delete this.localLedger[path];
		console.log("[S3 Sync] 观察者：记录墓碑", path);
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

		this.syncTimeout = window.setTimeout(() => {
			this.syncTimeout = null;
			console.log("[S3 Sync] 全局防抖触发：3 秒无新操作，开始同步");

			// 1. 持久化内存账本和墓碑
			this.persistLedger();
			this.persistTombstones();

			// 2. 执行增量同步
			this.startSync(true);
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

	// ── 状态栏 ──

	private updateStatusBar(phase: SyncPhase, progress?: { done: number; total: number }): void {
		if (!this.statusBarItem) return;

		switch (phase) {
			case "idle":
				this.statusBarItem.setText("☁ 就绪");
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
				setTimeout(() => this.updateStatusBar("idle"), 3000);
				break;
		}
	}

	// ── 定时自动同步 ──

	setupAutoSync(): void {
		// 定时同步逻辑由外部管理
	}

	// ── 同步入口 ──

	private async startSync(silent = false): Promise<void> {
		if (this._syncing) {
			if (!silent) new Notice("同步正在进行中，请稍候…");
			return;
		}

		const {accessKey, secretKey, endpoint, bucketName} = this.settings;
		if (!accessKey || !secretKey || !endpoint || !bucketName) {
			if (!silent) new Notice("请先在设置中填写完整的 S3 配置");
			return;
		}

		this._syncing = true;
		this.updateStatusBar("scanning");

		if (!silent) new Notice("S3 同步开始…");

		try {
			this.transferManager = new S3TransferManager(this.app.vault, this.settings);
			const result = await this.transferManager.fullSync(
				this.settings.deviceId,
				this.localLastSyncTime,
				(done, total) => { this.updateStatusBar("uploading", {done, total}); },
				this.localTombstones,
				this.localLedger,
			);

			const manifestFailed = result.failed.some(item => item.path === "manifest.json");
			if (!manifestFailed) {
				// manifest 条件写入成功后，才把本轮同步结果视为本地账本事实。
				this.localLedger = this.transferManager.localManifest;
				this.persistLedger();

				this.localLastSyncTime = Date.now();
				this.app.saveLocalStorage("s3-sync-last-sync-time", String(this.localLastSyncTime));
				this.persistTombstones();
			} else {
				console.warn("[S3 Sync] manifest 未提交成功，本地账本保持原状，等待下次同步重试");
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
