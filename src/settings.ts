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

		// ── 测试与调试 ──
		containerEl.createEl("h3", {text: "测试与调试"});

		new Setting(containerEl)
			.setName("执行全面同步与清理测试")
			.setDesc("此操作将获取云端列表、清理未同步的孤儿文件，并执行完整的增量同步。请务必打开开发者控制台 (Ctrl+Shift+I) 查看详细结构化日志。")
			.addButton(btn => {
				btn.setButtonText("🚀 运行测试")
					.setCta()
					.onClick(async () => {
						btn.setDisabled(true);
						btn.setButtonText("⏳ 正在测试...");
						new Notice("开始执行 S3 同步测试，请盯紧控制台！");

						try {
							const {S3TransferManager} = await import("./transfer");
							const manager = new S3TransferManager(this.app.vault, this.plugin.settings);
							const deviceId = await this.plugin.getDeviceId();
							const result = await manager.fullSync(deviceId);

							const lines: string[] = [];
							if (result.uploaded > 0) lines.push(`上传 ${result.uploaded}`);
							if (result.downloaded > 0) lines.push(`下载 ${result.downloaded}`);
							if (result.deleted > 0) lines.push(`删除 ${result.deleted}`);
							if (result.orphanCleaned > 0) lines.push(`清理孤儿 ${result.orphanCleaned}`);
							if (result.failed.length > 0) lines.push(`失败 ${result.failed.length}`);

							new Notice(`✅ 测试与同步圆满完成！${lines.length > 0 ? " " + lines.join("，") : ""}`);
						} catch (err: unknown) {
							const msg = err instanceof Error ? err.message : String(err);
							console.error("[S3 Sync] 测试失败：", err);
							new Notice(`❌ 测试失败：${msg}`, 8000);
						} finally {
							btn.setDisabled(false);
							btn.setButtonText("🚀 运行测试");
						}
					});
			});
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
				forcePathStyle: false,
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
