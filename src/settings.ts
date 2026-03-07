import { App, PluginSettingTab, Setting } from 'obsidian';
import type LazyCryptPlugin from './main';

export interface LazyCryptSettings {
	encryptedRemoteUrl: string;
	encryptedRemoteName: string;
	excludePatterns: string;
	autoSyncInterval: number;
	autoPushInterval: number;
	gitPath: string;
	agePath: string;
}

export const DEFAULT_SETTINGS: LazyCryptSettings = {
	encryptedRemoteUrl: '',
	encryptedRemoteName: 'origin',
	excludePatterns: '.DS_Store, .git, .lazycrypt',
	autoSyncInterval: 0,
	autoPushInterval: 0,
	gitPath: 'git',
	agePath: 'age'
};

export class LazyCryptSettingTab extends PluginSettingTab {
	plugin: LazyCryptPlugin;

	constructor(app: App, plugin: LazyCryptPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;

		containerEl.empty();

		new Setting(containerEl)
			.setName('Encrypted remote URL')
			.setDesc('The URL of the remote repository that will store the encrypted commits.')
			.addText(text => text
				.setPlaceholder('git@github.com:user/repo-lazycrypted.git')
				.setValue(this.plugin.settings.encryptedRemoteUrl)
				.onChange(async (value) => {
					this.plugin.settings.encryptedRemoteUrl = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Encrypted remote name')
			.setDesc('The name of the Git remote (default: origin).')
			.addText(text => text
				// eslint-disable-next-line obsidianmd/ui/sentence-case -- placeholder value
				.setPlaceholder('origin')
				.setValue(this.plugin.settings.encryptedRemoteName)
				.onChange(async (value) => {
					this.plugin.settings.encryptedRemoteName = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Exclude patterns')
			.setDesc('Comma-separated list of file or folder names to exclude from encryption.')
			.addText(text => text
				// eslint-disable-next-line obsidianmd/ui/sentence-case -- placeholder value
				.setPlaceholder('.DS_Store, .git, .lazycrypt')
				.setValue(this.plugin.settings.excludePatterns)
				.onChange(async (value) => {
					this.plugin.settings.excludePatterns = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Auto-sync interval (minutes)')
			.setDesc('Automatically sync plaintext commits to encrypted mirror. 0 to disable.')
			.addText(text => text
				.setPlaceholder('0')
				.setValue(String(this.plugin.settings.autoSyncInterval))
				.onChange(async (value) => {
					const val = parseInt(value, 10);
					if (!isNaN(val) && val >= 0) {
						this.plugin.settings.autoSyncInterval = val;
						await this.plugin.saveSettings();
						this.plugin.registerAutoSync();
					}
				}));

		new Setting(containerEl)
			.setName('Auto-push interval (minutes)')
			.setDesc('Automatically push encrypted mirror to remote. 0 to disable.')
			.addText(text => text
				.setPlaceholder('0')
				.setValue(String(this.plugin.settings.autoPushInterval))
				.onChange(async (value) => {
					const val = parseInt(value, 10);
					if (!isNaN(val) && val >= 0) {
						this.plugin.settings.autoPushInterval = val;
						await this.plugin.saveSettings();
						this.plugin.registerAutoPush();
					}
				}));

		new Setting(containerEl)
			.setName('Git binary path')
			.setDesc('Path to the Git executable (e.g., /usr/local/bin/git). Leave as "git" if it is in your system path.')
			.addText(text => text
				// eslint-disable-next-line obsidianmd/ui/sentence-case -- placeholder value
				.setPlaceholder('git')
				.setValue(this.plugin.settings.gitPath)
				.onChange(async (value) => {
					this.plugin.settings.gitPath = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Age binary path')
			.setDesc('Path to the Age executable (e.g., /usr/local/bin/age). Leave as "age" if it is in your system path.')
			.addText(text => text
				// eslint-disable-next-line obsidianmd/ui/sentence-case -- placeholder value
				.setPlaceholder('age')
				.setValue(this.plugin.settings.agePath)
				.onChange(async (value) => {
					this.plugin.settings.agePath = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Sync status')
			.setHeading();

		const unsyncedText = containerEl.createEl('span', { text: 'Loading...' });

		const updateCount = async (): Promise<void> => {
			try {
				const count = await this.plugin.lazycrypt.getUnsyncedCommitCount();
				unsyncedText.setText(`Unsynced commits: ${count}`);
			} catch {
				unsyncedText.setText('Unsynced commits: error checking status');
			}
		};

		void updateCount();
		const intervalId = window.setInterval(() => {
			void updateCount();
		}, 5000);

		// Clean up interval when the settings tab element is removed from the DOM
		const checkInterval = window.setInterval(() => {
			if (!unsyncedText.isShown()) {
				window.clearInterval(intervalId);
				window.clearInterval(checkInterval);
			}
		}, 1000);

		new Setting(containerEl)
			.setName('Manual controls')
			.setDesc('Trigger or stop the synchronization process.')
			.addButton(button => button
				.setButtonText('Sync now')
				.setCta()
				.onClick(() => {
					void this.plugin.syncLazyCrypt().then(() => updateCount());
				}))
			.addButton(button => button
				.setButtonText('Stop sync')
				.setWarning()
				.onClick(() => {
					this.plugin.stopSync();
				}))
			.addButton(button => button
				.setButtonText('Force clear lock')
				.setWarning()
				.setTooltip('Use this if sync is stuck due to a stale lock file.')
				.onClick(() => {
					this.plugin.clearLock();
				}));

		new Setting(containerEl)
			.setName('Public key')
			.setHeading();

		const keyText = containerEl.createEl('code', { text: 'Loading...', cls: 'lazycrypt-public-key' });

		void this.plugin.lazycrypt.getPublicKey().then(key => {
			keyText.setText(key || "No key found. Please initialize the repo.");
		});
	}
}
