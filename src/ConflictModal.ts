import {App, Modal} from "obsidian";

export type ConflictResolution = "local" | "cloud" | "both";

export class ConflictModal extends Modal {
	private readonly filePath: string;
	private readonly localDevice: string;
	private readonly cloudDevice: string;
	private readonly localMtime: number;
	private readonly cloudMtime: number;
	private readonly onResolve: (resolution: ConflictResolution) => void;

	constructor(
		app: App,
		filePath: string,
		localDevice: string,
		cloudDevice: string,
		localMtime: number,
		cloudMtime: number,
		onResolve: (resolution: ConflictResolution) => void,
	) {
		super(app);
		this.filePath = filePath;
		this.localDevice = localDevice;
		this.cloudDevice = cloudDevice;
		this.localMtime = localMtime;
		this.cloudMtime = cloudMtime;
		this.onResolve = onResolve;
	}

	onOpen(): void {
		const {contentEl} = this;
		contentEl.empty();

		contentEl.createEl("h3", {text: "文件冲突"});
		contentEl.createEl("p", {
			text: `文件 "${this.filePath}" 在两端均被修改，请选择保留哪个版本：`,
		});

		const infoEl = contentEl.createDiv({cls: "s3-sync-conflict-info"});

		const localInfo = infoEl.createDiv({cls: "s3-sync-conflict-side"});
		localInfo.createEl("strong", {text: "本地版本"});
		localInfo.createEl("div", {text: `设备：${this.localDevice || "未知"}`});
		localInfo.createEl("div", {text: `修改时间：${new Date(this.localMtime).toLocaleString()}`});

		const cloudInfo = infoEl.createDiv({cls: "s3-sync-conflict-side"});
		cloudInfo.createEl("strong", {text: "云端版本"});
		cloudInfo.createEl("div", {text: `设备：${this.cloudDevice || "未知"}`});
		cloudInfo.createEl("div", {text: `修改时间：${new Date(this.cloudMtime).toLocaleString()}`});

		const btnContainer = contentEl.createDiv({cls: "s3-sync-conflict-buttons"});

		const localBtn = btnContainer.createEl("button", {text: "以本地为准"});
		localBtn.addEventListener("click", () => {
			this.onResolve("local");
			this.close();
		});

		const cloudBtn = btnContainer.createEl("button", {text: "以云端为准"});
		cloudBtn.addEventListener("click", () => {
			this.onResolve("cloud");
			this.close();
		});

		const bothBtn = btnContainer.createEl("button", {text: "保留双份副本"});
		bothBtn.addEventListener("click", () => {
			this.onResolve("both");
			this.close();
		});
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
