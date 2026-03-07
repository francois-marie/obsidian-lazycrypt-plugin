import {App, PluginSettingTab, Setting} from "obsidian";
import LazyCryptPlugin from "./main";

export interface LazyCryptSettings {
	mySetting: string;
}

export const DEFAULT_SETTINGS: LazyCryptSettings = {
	mySetting: 'default'
}

export class LazyCryptSettingTab extends PluginSettingTab {
	plugin: LazyCryptPlugin;

	constructor(app: App, plugin: LazyCryptPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const {containerEl} = this;

		containerEl.empty();

		new Setting(containerEl)
			.setName('Settings #1')
			.setDesc('It\'s a secret')
			.addText(text => text
				.setPlaceholder('Enter your secret')
				.setValue(this.plugin.settings.mySetting)
				.onChange(async (value) => {
					this.plugin.settings.mySetting = value;
					await this.plugin.saveSettings();
				}));
	}
}
