import {App, Notice, PluginSettingTab, Setting} from "obsidian";
import {HeadBucketCommand, S3Client} from "@aws-sdk/client-s3";
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
	}

	private async testConnection(): Promise<void> {
		const {accessKey, secretKey, endpoint, region, bucketName} = this.plugin.settings;

		if (!accessKey || !secretKey || !endpoint || !bucketName) {
			new Notice("请先填写完整的 AK/SK、Endpoint 和 Bucket Name");
			return;
		}

		try {
			const client = new S3Client({
				credentials: {
					accessKeyId: accessKey,
					secretAccessKey: secretKey,
				},
				endpoint: endpoint,
				region: region || "us-east-1",
				forcePathStyle: true,
			});

			await client.send(new HeadBucketCommand({Bucket: bucketName}));
			new Notice("连接成功！存储桶可访问。");
		} catch (err: unknown) {
			const message = err instanceof Error ? err.message : String(err);
			new Notice(`连接失败：${message}`, 8000);
		}
	}
}
