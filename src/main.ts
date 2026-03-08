import { Notice, Plugin, FileSystemAdapter } from 'obsidian';
import * as path from 'path';
import * as fs from 'fs';
import { LazyCrypt } from './lazycrypt';
import { DEFAULT_SETTINGS, LazyCryptSettings, LazyCryptSettingTab } from "./settings";

/**
 * LazyCrypt plugin for Obsidian.
 * Maintains an encrypted git history of the vault using age encryption.
 */
export default class LazyCryptPlugin extends Plugin {
	settings: LazyCryptSettings;
	lazycrypt: LazyCrypt;
	statusBarItemEl: HTMLElement;
	autoSyncIntervalId?: number;
	autoPushIntervalId?: number;

	async onload(): Promise<void> {
		await this.loadSettings();

		const adapter = this.app.vault.adapter;
		if (!(adapter instanceof FileSystemAdapter)) {
			new Notice("This plugin only works on desktop with a local file system");
			return;
		}

		// Attempt auto-detection of Homebrew paths on macOS if defaults are still "git" and "age"
		if (this.settings.gitPath === 'git' || this.settings.agePath === 'age') {
			const commonPaths = ['/usr/local/bin', '/opt/homebrew/bin'];
			for (const p of commonPaths) {
				if (this.settings.gitPath === 'git') {
					const fullGit = path.join(p, 'git');
					if (fs.existsSync(fullGit)) this.settings.gitPath = fullGit;
				}
				if (this.settings.agePath === 'age') {
					const fullAge = path.join(p, 'age');
					if (fs.existsSync(fullAge)) this.settings.agePath = fullAge;
				}
			}
		}

		this.lazycrypt = new LazyCrypt(
			adapter.getBasePath(),
			this.settings.gitPath,
			this.settings.agePath
		);

		this.addRibbonIcon('lock', 'Sync encrypted history', async () => {
			await this.syncLazyCrypt();
		});

		this.statusBarItemEl = this.addStatusBarItem();
		this.updateStatusBar('Idle');

		this.addCommand({
			id: 'sync-encrypted-history',
			name: 'Sync encrypted history',
			callback: async () => {
				await this.syncLazyCrypt();
			}
		});

		this.addCommand({
			id: 'push-encrypted-history',
			name: 'Push encrypted history',
			callback: async () => {
				await this.pushLazyCrypt();
			}
		});

		this.addCommand({
			id: 'init-repository',
			name: 'Initialize repository',
			callback: async () => {
				await this.initLazyCrypt();
			}
		});

		this.addCommand({
			id: 'pull-decrypt-history',
			name: 'Pull and decrypt history',
			callback: async () => {
				await this.pullAndDecryptLazyCrypt();
			}
		});

		this.addSettingTab(new LazyCryptSettingTab(this.app, this));

		this.registerAutoSync();
		this.registerAutoPush();
	}

	onunload(): void {
		if (this.autoSyncIntervalId) window.clearInterval(this.autoSyncIntervalId);
		if (this.autoPushIntervalId) window.clearInterval(this.autoPushIntervalId);
	}

	async loadSettings(): Promise<void> {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData() as Partial<LazyCryptSettings>);
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
		if (this.lazycrypt) {
			const config = await this.lazycrypt.loadConfig();
			config.encrypted_remote.url = this.settings.encryptedRemoteUrl;
			config.encrypted_remote.name = this.settings.encryptedRemoteName;
			config.exclude_patterns = this.settings.excludePatterns.split(',').map(s => s.trim()).filter(s => s !== "");
			await this.lazycrypt.saveConfig(config);
			this.lazycrypt.setBinaryPaths(this.settings.gitPath, this.settings.agePath);
		}
	}

	updateStatusBar(status: string): void {
		this.statusBarItemEl.setText(`LazyCrypt: ${status}`);
	}

	registerAutoSync(): void {
		if (this.autoSyncIntervalId) window.clearInterval(this.autoSyncIntervalId);
		if (this.settings.autoSyncInterval > 0) {
			this.autoSyncIntervalId = window.setInterval(() => {
				void this.syncLazyCrypt();
			}, this.settings.autoSyncInterval * 60 * 1000);
			this.registerInterval(this.autoSyncIntervalId);
		}
	}

	registerAutoPush(): void {
		if (this.autoPushIntervalId) window.clearInterval(this.autoPushIntervalId);
		if (this.settings.autoPushInterval > 0) {
			this.autoPushIntervalId = window.setInterval(() => {
				void this.pushLazyCrypt();
			}, this.settings.autoPushInterval * 60 * 1000);
			this.registerInterval(this.autoPushIntervalId);
		}
	}

	async initLazyCrypt(): Promise<void> {
		try {
			this.updateStatusBar('Initializing...');
			await this.lazycrypt.initRepo();
			new Notice('Repository initialized');
			this.updateStatusBar('Initialized');
		} catch (error) {
			new Notice(`Init error: ${(error as Error).message}`);
			this.updateStatusBar('Init error');
		}
	}

	async syncLazyCrypt(): Promise<void> {
		try {
			this.updateStatusBar('Syncing...');
			new Notice('Started syncing encrypted history...');
			const count = await this.lazycrypt.sync((synced, total) => {
				const left = total - synced;
				this.updateStatusBar(`Syncing (${synced}/${total})...`);
				if (synced % 10 === 0 || synced === total) {
					new Notice(`Syncing: ${left} commits left...`);
				}
			});
			new Notice(`Finished syncing: ${count} commits encrypted`);
			this.updateStatusBar('Synced');
		} catch (error) {
			const msg = (error as Error).message;
			if (msg === "Sync aborted by user") {
				new Notice("Sync stopped by user");
				this.updateStatusBar('Aborted');
			} else {
				new Notice(`Sync error: ${msg}`);
				this.updateStatusBar('Sync error');
			}
		}
	}

	async pushLazyCrypt(): Promise<void> {
		try {
			this.updateStatusBar('Pushing...');
			new Notice('Pushing to encrypted remote...');
			await this.lazycrypt.push();
			new Notice('Finished pushing to encrypted remote');
			this.updateStatusBar('Pushed');
		} catch (error) {
			new Notice(`Push error: ${(error as Error).message}`);
			this.updateStatusBar('Push error');
		}
	}

	async pullAndDecryptLazyCrypt(): Promise<void> {
		try {
			this.updateStatusBar('Pulling...');
			new Notice('Pulling from encrypted remote...');
			await this.lazycrypt.pull();

			this.updateStatusBar('Decrypting...');
			new Notice('Starting decryption into plaintext vault...');
			const count = await this.lazycrypt.decryptSync((synced, total) => {
				this.updateStatusBar(`Decrypting (${synced}/${total})...`);
			});
			new Notice(`Finished recovery: ${count} commits decrypted`);
			this.updateStatusBar('Recovered');
		} catch (error) {
			new Notice(`Recovery error: ${(error as Error).message}`);
			this.updateStatusBar('Recovery error');
		}
	}

	stopSync(): void {
		this.lazycrypt.stopSync();
		new Notice('Stopping sync... (will abort after current commit)');
	}

	clearLock(): void {
		this.lazycrypt.clearLock();
		new Notice('Sync lock cleared');
		this.updateStatusBar('Idle');
	}
}
