import {Notice, Plugin} from "obsidian";
import {DEFAULT_SETTINGS, S3BackupSettings, S3SyncSettingTab} from "./settings";
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

const DEBOUNCE_MS = 5000;

export default class S3SyncPlugin extends Plugin {
	settings: S3BackupSettings;
	private deviceId = "";
	private syncing = false;
	private syncTimer: number | null = null;
	private debounceTimer: number | null = null;
	private localLastSyncTime = 0;
	private statusBarItem: HTMLElement | null = null;
	private beforeUnloadHandler: ((evt: BeforeUnloadEvent) => void) | null = null;
	private visibilityHandler: (() => void) | null = null;

	async onload() {
		await this.loadSettings();
		this.deviceId = await this.getDeviceId();

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

		// 定时自动同步（受 autoSync 开关和 syncInterval 控制）
		this.setupAutoSync();

		// 事件防抖同步：监听文件变更，5秒无新操作后自动同步
		this.registerEvent(this.app.vault.on("modify", () => this.scheduleDebouncedSync()));
		this.registerEvent(this.app.vault.on("create", () => this.scheduleDebouncedSync()));
		this.registerEvent(this.app.vault.on("delete", () => this.scheduleDebouncedSync()));
		this.registerEvent(this.app.vault.on("rename", () => this.scheduleDebouncedSync()));

		// 电脑端退出拦截
		this.beforeUnloadHandler = (evt: BeforeUnloadEvent) => {
			this.onBeforeUnload();
			if (this.syncing) {
				evt.preventDefault();
			}
		};
		window.addEventListener("beforeunload", this.beforeUnloadHandler);

		// 移动端挂起同步：App 切到后台时延迟 2 秒触发紧急同步（等待 Obsidian 保存）
		this.visibilityHandler = () => {
			if (document.visibilityState === "hidden") {
				setTimeout(() => this.onAppSuspend(), 2000);
			}
		};
		document.addEventListener("visibilitychange", this.visibilityHandler);
	}

	onunload() {
		// 插件卸载时触发快速同步
		this.onBeforeUnload();

		if (this.syncTimer !== null) {
			window.clearInterval(this.syncTimer);
			this.syncTimer = null;
		}
		if (this.debounceTimer !== null) {
			window.clearTimeout(this.debounceTimer);
			this.debounceTimer = null;
		}
		if (this.beforeUnloadHandler) {
			window.removeEventListener("beforeunload", this.beforeUnloadHandler);
			this.beforeUnloadHandler = null;
		}
		if (this.visibilityHandler) {
			document.removeEventListener("visibilitychange", this.visibilityHandler);
			this.visibilityHandler = null;
		}
	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData() as Partial<S3BackupSettings>);
	}

	async saveSettings() {
		await this.saveData(this.settings);
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
		if (this.syncTimer !== null) {
			window.clearInterval(this.syncTimer);
			this.syncTimer = null;
		}

		if (!this.settings.autoSync) return;

		const ms = this.settings.syncInterval * 60 * 1000;
		this.syncTimer = window.setInterval(() => {
			if (!navigator.onLine) {
				console.log("[S3 Sync] 📴 当前离线，跳过定时同步");
				return;
			}
			console.log(`[S3 Sync] ⏰ 触发 ${this.settings.syncInterval} 分钟定时同步...`);
			this.startSync(true);
		}, ms);
	}

	// ── 事件防抖同步 ──

	private scheduleDebouncedSync(): void {
		const {accessKey, secretKey, endpoint, bucketName} = this.settings;
		if (!accessKey || !secretKey || !endpoint || !bucketName) return;

		if (this.debounceTimer !== null) {
			window.clearTimeout(this.debounceTimer);
		}

		this.debounceTimer = window.setTimeout(() => {
			this.debounceTimer = null;
			console.log("[S3 Sync] 防抖触发：文件变更后自动同步");
			this.startSync(true);
		}, DEBOUNCE_MS);
	}

	// ── 电脑端退出拦截 ──

	private onBeforeUnload(): void {
		const {accessKey, secretKey, endpoint, bucketName} = this.settings;
		if (!accessKey || !secretKey || !endpoint || !bucketName) return;
		if (this.syncing) return;

		this.syncing = true;
		console.log("[S3 Sync] 退出前触发快速同步…");

		try {
			const manager = new S3TransferManager(this.app.vault, this.settings);
			manager.quickSync(this.deviceId, this.localLastSyncTime, 5 * 60 * 1000)
				.then((syncResult) => {
					console.log("[S3 Sync] 退出同步完成：上传", syncResult.uploaded, "删除", syncResult.deleted);
					if (syncResult.uploaded > 0 || syncResult.downloaded > 0 || syncResult.deleted > 0) {
						this.localLastSyncTime = Date.now();
						this.app.saveLocalStorage("s3-sync-last-sync-time", String(this.localLastSyncTime));
					}
				})
				.catch((err: unknown) => {
					console.error("[S3 Sync] 退出同步失败：", err);
				})
				.finally(() => {
					this.syncing = false;
				});
		} catch (err: unknown) {
			console.error("[S3 Sync] 退出同步异常：", err);
			this.syncing = false;
		}
	}

	// ── 移动端挂起同步 ──

	private onAppSuspend(): void {
		const {accessKey, secretKey, endpoint, bucketName} = this.settings;
		if (!accessKey || !secretKey || !endpoint || !bucketName) return;
		if (this.syncing) return;

		this.syncing = true;
		console.log("[S3 Sync] App 挂起，触发紧急同步…");

		try {
			const manager = new S3TransferManager(this.app.vault, this.settings);
			manager.quickSync(this.deviceId, this.localLastSyncTime, 5 * 60 * 1000)
				.then((syncResult) => {
					console.log("[S3 Sync] 挂起同步完成：上传", syncResult.uploaded, "删除", syncResult.deleted);
					if (syncResult.uploaded > 0 || syncResult.downloaded > 0 || syncResult.deleted > 0) {
						this.localLastSyncTime = Date.now();
						this.app.saveLocalStorage("s3-sync-last-sync-time", String(this.localLastSyncTime));
					}
				})
				.catch((err: unknown) => {
					console.error("[S3 Sync] 挂起同步失败：", err);
				})
				.finally(() => {
					this.syncing = false;
				});
		} catch (err: unknown) {
			console.error("[S3 Sync] 挂起同步异常：", err);
			this.syncing = false;
		}
	}

	// ── 设备 ID ──

	async getDeviceId(): Promise<string> {
		const stored = this.app.loadLocalStorage("s3-sync-device-id");
		if (stored) return stored;

		const id = generateDeviceId();
		this.app.saveLocalStorage("s3-sync-device-id", id);
		return id;
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
			const manager = new S3TransferManager(this.app.vault, this.settings);
			const result = await manager.fullSync(this.deviceId, this.localLastSyncTime, (done, total) => {
				this.updateStatusBar("uploading", {done, total});
			});

			// 同步成功后更新本地上次同步时间
			this.localLastSyncTime = Date.now();
			this.app.saveLocalStorage("s3-sync-last-sync-time", String(this.localLastSyncTime));

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