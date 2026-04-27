import {Notice, Plugin, TAbstractFile, TFile} from "obsidian";
import {DEFAULT_SETTINGS, S3BackupSettings, S3SyncSettingTab} from "./settings";
import {DeletedEntry} from "./scanner";
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

const DEBOUNCE_MS = 3000; // 全局防抖 3 秒
const TOMBSTONE_EXPIRY_MS = 30 * 24 * 60 * 60 * 1000; // 30 天

export default class S3SyncPlugin extends Plugin {
	settings: S3BackupSettings;
	private syncing = false;
	private syncTimeout: number | null = null; // 全局防抖定时器
	private localLastSyncTime = 0;
	private statusBarItem: HTMLElement | null = null;
	private transferManager: S3TransferManager | null = null;

	// ── 内存级同步墓碑：纯同步赋值，杜绝竞态覆盖 ──
	public localTombstones: Record<string, DeletedEntry> = {};

	async onload() {
		await this.loadSettings();

		// 确保 deviceId 存在
		if (!this.settings.deviceId) {
			this.settings.deviceId = generateDeviceId();
			await this.saveSettings();
		}

		// 加载本地墓碑记录
		this.localTombstones = this.loadTombstones();

		// 读取本地上次同步时间戳
		const storedTime = this.app.loadLocalStorage("s3-sync-last-sync-time");
		this.localLastSyncTime = storedTime ? parseInt(storedTime, 10) : 0;

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

		// ── 全局防抖引擎：所有文件事件统一接入 ──
		this.registerEvent(this.app.vault.on("modify", () => this.triggerDebouncedSync()));
		this.registerEvent(this.app.vault.on("create", () => this.triggerDebouncedSync()));
		this.registerEvent(this.app.vault.on("delete", (file) => this.onFileDelete(file)));
		this.registerEvent(this.app.vault.on("rename", (file, oldPath) => {
			this.onFileDeleteByPath(oldPath);
			this.triggerDebouncedSync();
		}));
	}

	onunload() {
		if (this.syncTimeout !== null) {
			window.clearTimeout(this.syncTimeout);
			this.syncTimeout = null;
		}
		if (this.settings.autoSync) {
			// 清理定时器由 setupAutoSync 管理，此处不再重复
		}
	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData() as Partial<S3BackupSettings>);
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}

	// ── 本地墓碑：同步内存读写，异步持久化 ──

	private loadTombstones(): Record<string, DeletedEntry> {
		const raw = this.app.loadLocalStorage("s3-sync-tombstones");
		if (!raw) return {};
		try {
			return JSON.parse(raw) as Record<string, DeletedEntry>;
		} catch {
			return {};
		}
	}

	private async persistTombstones(): Promise<void> {
		this.pruneTombstones();
		this.app.saveLocalStorage("s3-sync-tombstones", JSON.stringify(this.localTombstones));
	}

	private pruneTombstones(): void {
		const now = Date.now();
		for (const [path, entry] of Object.entries(this.localTombstones)) {
			if (now - entry.mtime > TOMBSTONE_EXPIRY_MS) {
				delete this.localTombstones[path];
			}
		}
	}

	// ── 文件删除拦截 → 纯同步内存赋值，杜绝竞态覆盖 ──

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
		if (!(file instanceof TFile)) return;
		this.onFileDeleteByPath(file.path);
		this.triggerDebouncedSync();
	}

	private onFileDeleteByPath(path: string): void {
		// 只记录 .md 文件且不在排除目录中
		if (!path.endsWith(".md")) return;
		if (this.isPathExcluded(path)) return;

		// 纯同步内存赋值 — 绝不 await，杜绝并发覆盖
		this.localTombstones[path] = {mtime: Date.now(), deletedBy: this.settings.deviceId};
		console.log("[S3 Sync] 记录墓碑：", path);
	}

	// ── 全局防抖器：3 秒无新操作 → 持久化墓碑 + 触发同步 ──

	private triggerDebouncedSync(): void {
		const {accessKey, secretKey, endpoint, bucketName} = this.settings;
		if (!accessKey || !secretKey || !endpoint || !bucketName) return;

		if (this.syncTimeout !== null) {
			window.clearTimeout(this.syncTimeout);
		}

		this.syncTimeout = window.setTimeout(async () => {
			this.syncTimeout = null;
			console.log("[S3 Sync] 全局防抖触发：3 秒无新操作，开始同步");

			// 1. 先持久化内存墓碑到硬盘
			await this.persistTombstones();

			// 2. 执行增量同步
			await this.startSync(true);
		}, DEBOUNCE_MS);
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
		// 清理旧定时器逻辑由外部管理
	}

	// ── 同步入口 ──

	private async startSync(silent = false): Promise<void> {
		if (this.syncing) {
			if (!silent) new Notice("同步正在进行中，请稍候…");
			return;
		}

		const {accessKey, secretKey, endpoint, bucketName} = this.settings;
		if (!accessKey || !secretKey || !endpoint || !bucketName) {
			if (!silent) new Notice("请先在设置中填写完整的 S3 配置");
			return;
		}

		this.syncing = true;
		this.updateStatusBar("scanning");

		if (!silent) new Notice("S3 同步开始…");

		try {
			this.transferManager = new S3TransferManager(this.app.vault, this.settings);
			const result = await this.transferManager.fullSync(this.settings.deviceId, this.localLastSyncTime, (done, total) => {
				this.updateStatusBar("uploading", {done, total});
			}, this.localTombstones);

			// 同步成功后更新本地上次同步时间
			this.localLastSyncTime = Date.now();
			this.app.saveLocalStorage("s3-sync-last-sync-time", String(this.localLastSyncTime));

			// 清理已处理的墓碑
			this.pruneTombstones();
			await this.persistTombstones();

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
			this.syncing = false;
		}
	}
}
