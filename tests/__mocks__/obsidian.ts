// Mock for Obsidian module — 只导出测试所需的最小接口
export class Notice {
	constructor(public message: string, public timeout?: number) {}
}

export class Plugin {
	app: any = {
		vault: {
			adapter: null,
			on: jest.fn(),
		},
		loadLocalStorage: jest.fn(),
		saveLocalStorage: jest.fn(),
		addStatusBarItem: jest.fn(),
		addRibbonIcon: jest.fn(),
		addCommand: jest.fn(),
		addSettingTab: jest.fn(),
	};
	settings: any = {};
	async loadData() { return {}; }
	async saveData(_data: any) {}
}

export class PluginSettingTab {
	containerEl: any = { empty: jest.fn(), createEl: jest.fn() };
	constructor(_app: any, _plugin: any) {}
}

export class Setting {
	constructor(_containerEl: any) {}
	setName(_name: string) { return this; }
	setDesc(_desc: string) { return this; }
	addText(_cb: any) { return this; }
	addTextArea(_cb: any) { return this; }
	addToggle(_cb: any) { return this; }
	addButton(_cb: any) { return this; }
	addExtraButton(_cb: any) { return this; }
}

export class TFile {
	path: string;
	name: string;
	extension: string;
	constructor(path: string) {
		this.path = path;
		const parts = path.split("/");
		this.name = parts[parts.length - 1] ?? "";
		this.extension = this.name.split(".").pop() ?? "";
	}
}

export class TFolder {
	path: string;
	name: string;
	children: any[] = [];
	constructor(path: string) {
		this.path = path;
		this.name = path.split("/").pop() ?? "";
	}
}

export class TAbstractFile {
	path: string;
	constructor(path: string) { this.path = path; }
}

export class Modal {
	app: any;
	contentEl: any = { empty: jest.fn(), createEl: jest.fn(), createDiv: jest.fn() };
	constructor(_app: any) {}
	onOpen() {}
	onClose() {}
	close() {}
}