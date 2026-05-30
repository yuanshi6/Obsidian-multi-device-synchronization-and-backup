import {App, Notice, PluginSettingTab, Setting} from "obsidian";
import {ListObjectsV2Command, S3Client} from "@aws-sdk/client-s3";
import S3SyncPlugin from "./main";

export interface S3BackupSettings {
	accessKey: string;
	secretKey: string;
	endpoint: string;
	region: string;
	bucketName: string;
	autoSync: boolean;
	syncInterval: number;
	excludePatterns: string;
	deviceId: string;
	deviceName: string;
	forcePathStyle: boolean;
	storagePrefix: string;
	enableConditionalWrite: boolean;
	enableOrphanCleanup: boolean;
}

export const DEFAULT_SETTINGS: S3BackupSettings = {
	accessKey: "",
	secretKey: "",
	endpoint: "",
	region: "",
	bucketName: "",
	autoSync: false,
	syncInterval: 30,
	excludePatterns: ".obsidian,.trash",
	deviceId: "",
	deviceName: "未命名设备",
	forcePathStyle: false,
	storagePrefix: "_obsidian-sync/",
	enableConditionalWrite: true,
	enableOrphanCleanup: false,
};

export class S3SyncSettingTab extends PluginSettingTab {
	plugin: S3SyncPlugin;

	constructor(app: App, plugin: S3SyncPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const {containerEl} = this;
		containerEl.empty();

		// ── 身份验证 ──
		containerEl.createEl("h3", {text: "身份验证"});

		new Setting(containerEl)
			.setName("Access Key (AK)")
			.setDesc("S3 兼容存储的 Access Key ID")
			.addText(text => text
				.setPlaceholder("输入 Access Key")
				.setValue(this.plugin.settings.accessKey)
				.onChange(async (value) => {
					this.plugin.settings.accessKey = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName("Secret Key (SK)")
			.setDesc("S3 兼容存储的 Secret Access Key")
			.addText(text => {
				text.inputEl.type = "password";
				text.setPlaceholder("输入 Secret Key")
					.setValue(this.plugin.settings.secretKey)
					.onChange(async (value) => {
						this.plugin.settings.secretKey = value;
						await this.plugin.saveSettings();
					});
			});

		new Setting(containerEl)
			.setName("测试连接")
			.setDesc("验证当前 AK/SK 与存储桶配置是否可用")
			.addButton(btn => btn
				.setButtonText("测试连接")
				.setCta()
				.onClick(async () => {
					await this.testConnection();
				}));

		// ── 存储目标 ──
		containerEl.createEl("h3", {text: "存储目标"});

		new Setting(containerEl)
			.setName("Endpoint")
			.setDesc("S3 兼容服务的 Endpoint（如 https://cos.ap-beijing.myqcloud.com）")
			.addText(text => text
				.setPlaceholder("https://cos.ap-beijing.myqcloud.com")
				.setValue(this.plugin.settings.endpoint)
				.onChange(async (value) => {
					this.plugin.settings.endpoint = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName("Region")
			.setDesc("存储桶所在区域（如 ap-beijing）")
			.addText(text => text
				.setPlaceholder("ap-beijing")
				.setValue(this.plugin.settings.region)
				.onChange(async (value) => {
					this.plugin.settings.region = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName("Bucket Name")
			.setDesc("S3 存储桶名称")
			.addText(text => text
				.setPlaceholder("输入 Bucket 名称")
				.setValue(this.plugin.settings.bucketName)
				.onChange(async (value) => {
					this.plugin.settings.bucketName = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName("存储前缀 (Storage Prefix)")
			.setDesc("控制文件和同步对象存储的 S3 前缀路径，建议保持默认值以隔离数据")
			.addText(text => text
				.setPlaceholder("_obsidian-sync/")
				.setValue(this.plugin.settings.storagePrefix)
				.onChange(async (value) => {
					this.plugin.settings.storagePrefix = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName("强制使用路径风格 (Force Path Style)")
			.setDesc("对于 MinIO 或某些特定 S3 服务，强制将桶名放在 URL 路径中（如 http://endpoint/bucket）")
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.forcePathStyle)
				.onChange(async (value) => {
					this.plugin.settings.forcePathStyle = value;
					await this.plugin.saveSettings();
				}));

		// ── 设备身份 ──
		containerEl.createEl("h3", {text: "设备身份"});

		new Setting(containerEl)
			.setName("设备名称")
			.setDesc("用于在多设备同步时标识本设备，建议使用有辨识度的名称（如'公司电脑'、'手机'）")
			.addText(text => text
				.setPlaceholder("未命名设备")
				.setValue(this.plugin.settings.deviceName)
				.onChange(async (value) => {
					this.plugin.settings.deviceName = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName("设备 ID")
			.setDesc(`自动生成的唯一标识符：${this.plugin.settings.deviceId || "尚未生成"}`)
			.addExtraButton(btn => btn
				.setIcon("copy")
				.setTooltip("复制设备 ID")
				.onClick(() => {
					navigator.clipboard.writeText(this.plugin.settings.deviceId);
					new Notice("设备 ID 已复制");
				}));

		// ── 同步策略 ──
		containerEl.createEl("h3", {text: "同步策略"});

		new Setting(containerEl)
			.setName("自动同步")
			.setDesc("启用后将按设定间隔自动同步")
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.autoSync)
				.onChange(async (value) => {
					this.plugin.settings.autoSync = value;
					await this.plugin.saveSettings();
					this.plugin.setupAutoSync();
				}));

		new Setting(containerEl)
			.setName("同步间隔（分钟）")
			.setDesc("自动同步的时间间隔，默认 30 分钟")
			.addText(text => text
				.setPlaceholder("30")
				.setValue(String(this.plugin.settings.syncInterval))
				.onChange(async (value) => {
					const num = parseInt(value, 10);
					if (!isNaN(num) && num > 0) {
						this.plugin.settings.syncInterval = num;
						await this.plugin.saveSettings();
						this.plugin.setupAutoSync();
					}
				}));

		new Setting(containerEl)
			.setName("排除模式")
			.setDesc("同步时排除的路径模式，以英文逗号分隔（如 .obsidian,.trash,*.tmp）")
			.addTextArea(text => text
				.setPlaceholder(".obsidian,.trash")
				.setValue(this.plugin.settings.excludePatterns)
				.onChange(async (value) => {
					this.plugin.settings.excludePatterns = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName("启用条件写入 (Conditional Write)")
			.setDesc("利用 S3 的 ETag / IfMatch 特性，防止多设备同时上传 manifest 时发生相互覆盖")
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.enableConditionalWrite)
				.onChange(async (value) => {
					this.plugin.settings.enableConditionalWrite = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName("允许手动清理孤儿文件")
			.setDesc("允许维护按钮扫描插件专属对象前缀并清理超过 24 小时未被 manifest 引用的对象。默认关闭。")
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.enableOrphanCleanup)
				.onChange(async (value) => {
					this.plugin.settings.enableOrphanCleanup = value;
					await this.plugin.saveSettings();
				}));

		// ── 手动操作 ──
		containerEl.createEl("h3", {text: "手动操作与维护"});

		new Setting(containerEl)
			.setName("执行完整同步 (Manual Full Sync)")
			.setDesc("立即触发一次完整的双向增量同步（使用真实的本地账本与墓碑状态）")
			.addButton(btn => btn
				.setButtonText("🔄 立即同步")
				.setCta()
				.onClick(async () => {
					btn.setDisabled(true);
					new Notice("手动同步开始...");
					try {
						await (this.plugin as any).startSync(false);
					} catch (err: unknown) {
						const msg = err instanceof Error ? err.message : String(err);
						new Notice(`同步失败: ${msg}`);
					} finally {
						btn.setDisabled(false);
					}
				}));

		new Setting(containerEl)
			.setName("清理云端孤儿文件 (Clean Orphan Files)")
			.setDesc("扫描插件专属前缀目录（objects/），清理所有不在 manifest.json 中且存在超过 24 小时的多余对象文件。此操作安全且不触碰其他目录。")
			.addButton(btn => btn
				.setButtonText("🗑️ 清理孤儿文件")
				.setClass("mod-warning")
				.onClick(async () => {
					if (!this.plugin.settings.enableOrphanCleanup) {
						new Notice("请先启用“允许手动清理孤儿文件”，再执行清理。", 8000);
						return;
					}
					if (!confirm("确定要清理云端孤儿文件吗？这会列出所有前缀对象并删除未被 manifest 引用的旧文件（超过 24 小时）。")) {
						return;
					}
					btn.setDisabled(true);
					btn.setButtonText("⏳ 正在清理...");
					new Notice("正在连接 S3 清理孤儿文件...");
					try {
						const {S3TransferManager} = await import("./transfer");
						const manager = new S3TransferManager(this.app.vault, this.plugin.settings);
						const cloudManifest = await manager.fetchCloudManifest();
						const count = await manager.cleanOrphanFiles(cloudManifest);
						new Notice(`✅ 成功清理了 ${count} 个云端孤儿文件`);
					} catch (err: unknown) {
						const msg = err instanceof Error ? err.message : String(err);
						new Notice(`❌ 清理失败: ${msg}`, 8000);
					} finally {
						btn.setDisabled(false);
						btn.setButtonText("🗑️ 清理孤儿文件");
					}
				}));
	}

	private cleanEndpoint(endpoint: string, bucketName: string): string {
		let cleaned = endpoint.trim();

		// 补全协议头
		if (!/^https?:\/\//.test(cleaned)) {
			cleaned = "https://" + cleaned;
		}

		// 移除末尾斜杠
		cleaned = cleaned.replace(/\/+$/, "");

		// 如果 endpoint 中包含了桶名（如 https://bucket-name.cos.ap-chongqing.myqcloud.com），移除桶名
		if (bucketName) {
			const escaped = bucketName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
			cleaned = cleaned.replace(new RegExp(`^https?://${escaped}\\.`), "https://");
		}

		return cleaned;
	}

	private async testConnection(): Promise<void> {
		const {accessKey, secretKey, region, bucketName} = this.plugin.settings;
		const rawEndpoint = this.plugin.settings.endpoint;
		const endpoint = this.cleanEndpoint(rawEndpoint, bucketName);

		console.log("[S3 Sync] 测试连接 — 配置参数：", {
			Endpoint: endpoint,
			"Raw Endpoint": rawEndpoint,
			Bucket: bucketName,
			Region: region || "us-east-1",
			AK: accessKey ? `${accessKey.slice(0, 4)}****` : "(空)",
			SK: secretKey ? "****" : "(空)",
		});

		// 逐项校验
		const missing: string[] = [];
		if (!accessKey) missing.push("Access Key");
		if (!secretKey) missing.push("Secret Key");
		if (!rawEndpoint) missing.push("Endpoint");
		if (!bucketName) missing.push("Bucket Name");
		if (missing.length > 0) {
			console.warn("[S3 Sync] 测试连接 — 缺失配置项：", missing);
			new Notice(`请先填写：${missing.join("、")}`, 6000);
			return;
		}

		// SK 空格检查
		if (secretKey !== secretKey.trim()) {
			console.warn("[S3 Sync] 测试连接 — Secret Key 包含首尾空格，已自动去除");
		}

		// Endpoint 自动修正
		const endpointChanged = endpoint !== rawEndpoint.trim().replace(/\/+$/, "");
		if (endpointChanged) {
			console.log("[S3 Sync] 测试连接 — Endpoint 已自动修正：", rawEndpoint, "→", endpoint);
			new Notice(`Endpoint 已自动修正为：${endpoint}`, 6000);
		}

		try {
			const client = new S3Client({
				credentials: {
					accessKeyId: accessKey.trim(),
					secretAccessKey: secretKey.trim(),
				},
				endpoint: endpoint,
				region: region || "us-east-1",
				forcePathStyle: this.plugin.settings.forcePathStyle,
			});

			console.log("[S3 Sync] 测试连接 — 发送 ListObjectsV2Command (MaxKeys:1)…");
			const result = await client.send(new ListObjectsV2Command({
				Bucket: bucketName,
				MaxKeys: 1,
			}));

			console.log("[S3 Sync] 测试连接 — 成功！", {
				Name: result.Name,
				IsTruncated: result.IsTruncated,
				KeyCount: result.KeyCount,
			});
			new Notice(`连接成功！\nBucket: ${result.Name ?? bucketName}\nEndpoint: ${endpoint}\nRegion: ${region || "us-east-1"}`, 6000);
		} catch (err: unknown) {
			const errMessage = err instanceof Error ? err.message : String(err);
			const errName = (err as { name?: string })?.name ?? "UnknownError";
			const metadata = (err as { $metadata?: { httpStatusCode?: number; requestId?: string; extendedRequestId?: string } })?.$metadata;
			const httpStatus = metadata?.httpStatusCode;
			const requestId = metadata?.requestId ?? metadata?.extendedRequestId ?? "无";

			console.error("[S3 Sync] 测试连接 — 失败，完整错误对象：", err);
			console.error("[S3 Sync] 测试连接 — 错误详情：", {
				name: errName,
				message: errMessage,
				httpStatusCode: httpStatus,
				requestId: requestId,
				Endpoint: endpoint,
				Bucket: bucketName,
				Region: region || "us-east-1",
				AK: accessKey.trim().slice(0, 4) + "****",
			});

			let hint = "";
			if (httpStatus === 403) {
				hint = "\n\n403 排查建议：\n1. 检查子账号是否有 cos:GetBucket 权限\n2. 检查电脑系统时间是否准确\n3. 检查 Secret Key 是否包含多余空格";
			}

			new Notice(
				`连接失败 [${errName}] HTTP ${httpStatus ?? "?"}\n` +
				`Endpoint: ${endpoint}\n` +
				`Bucket: ${bucketName}\n` +
				`Region: ${region || "us-east-1"}\n` +
				`AK: ${accessKey.trim().slice(0, 4)}****\n` +
				`RequestId: ${requestId}\n` +
				`错误: ${errMessage}` +
				hint,
				12000,
			);
		}
	}
}
