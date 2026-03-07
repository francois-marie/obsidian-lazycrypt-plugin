import { SimpleGit, simpleGit } from 'simple-git';
import * as path from 'path';
import * as fs from 'fs';
import { spawn } from 'child_process';
import * as yaml from 'js-yaml';

export interface RemoteConfig {
    name: string;
    url: string;
}

export interface RetiredKey {
    path: string;
    retired_at: string;
}

export interface Config {
    version: number;
    current_key: string;
    encrypted_remote: RemoteConfig;
    exclude_patterns: string[];
    retired_keys: RetiredKey[];
}

export interface Commit {
    sha: string;
    message: string;
    synced: boolean;
}

export class LazyCrypt {
    private vaultPath: string;
    private git: SimpleGit;
    private config: Config;
    private isAborted: boolean = false;
    private gitPath: string;
    private agePath: string;

    constructor(vaultPath: string, gitPath: string = 'git', agePath: string = 'age') {
        this.vaultPath = vaultPath;
        this.gitPath = gitPath;
        this.agePath = agePath;
        this.git = simpleGit(vaultPath, { binary: gitPath });
    }

    setBinaryPaths(gitPath: string, agePath: string) {
        this.gitPath = gitPath;
        this.agePath = agePath;
        this.git = simpleGit(this.vaultPath, { binary: gitPath });
    }

    private lazycryptDir(): string { return path.join(this.vaultPath, '.lazycrypt'); }
    private configPath(): string { return path.join(this.lazycryptDir(), 'config.yml'); }
    private commitMapPath(): string { return path.join(this.lazycryptDir(), 'commit-map'); }
    private encryptedRepoPath(): string { return path.join(this.lazycryptDir(), 'encrypted.git'); }
    private keysDir(): string { return path.join(this.lazycryptDir(), 'keys'); }
    private currentKeyPath(): string { return path.join(this.keysDir(), 'current.key'); }
    private lockPath(): string { return path.join(this.lazycryptDir(), 'sync.lock'); }

    clearLock(): void {
        if (fs.existsSync(this.lockPath())) {
            fs.unlinkSync(this.lockPath());
        }
    }

    async checkPrereqs(): Promise<{ hasGit: boolean, hasAge: boolean, initialized: boolean }> {
        const hasGit = await this.commandExists('git');
        const hasAge = await this.commandExists('age');
        const initialized = fs.existsSync(this.configPath());
        return { hasGit, hasAge, initialized };
    }

    private async commandExists(command: string): Promise<boolean> {
        const binary = command === 'git' ? this.gitPath : (command === 'age' ? this.agePath : (command === 'age-keygen' ? path.join(path.dirname(this.agePath), 'age-keygen') : command));

        // If it's an absolute path, just check if it exists
        if (path.isAbsolute(binary)) {
            return fs.existsSync(binary);
        }

        // Otherwise try 'which'
        return new Promise((resolve) => {
            const child = spawn('which', [binary]);
            child.on('exit', (code) => resolve(code === 0));
        });
    }

    async loadConfig(): Promise<Config> {
        if (!fs.existsSync(this.configPath())) {
            return {
                version: 1,
                current_key: 'keys/current.key',
                encrypted_remote: { name: 'origin', url: '' },
                exclude_patterns: ['.DS_Store', '.git', '.lazycrypt'],
                retired_keys: []
            };
        }
        const content = fs.readFileSync(this.configPath(), 'utf8');
        this.config = yaml.load(content) as Config;
        return this.config;
    }

    async saveConfig(config: Config): Promise<void> {
        this.config = config;
        if (!fs.existsSync(this.lazycryptDir())) fs.mkdirSync(this.lazycryptDir(), { recursive: true });
        fs.writeFileSync(this.configPath(), yaml.dump(config), 'utf8');
    }

    async initRepo(): Promise<void> {
        if (!fs.existsSync(this.lazycryptDir())) fs.mkdirSync(this.lazycryptDir(), { recursive: true });
        if (!fs.existsSync(this.keysDir())) fs.mkdirSync(this.keysDir(), { recursive: true });

        const encPath = this.encryptedRepoPath();
        if (!fs.existsSync(encPath)) {
            fs.mkdirSync(encPath, { recursive: true });
            const encGit = simpleGit(encPath, { binary: this.gitPath });
            await encGit.init(true); // Bare repo for mirror
        }

        if (!fs.existsSync(this.currentKeyPath())) {
            await this.generateKey();
        }

        await this.saveConfig(await this.loadConfig());
    }

    private async generateKey(): Promise<void> {
        return new Promise((resolve, reject) => {
            const keyPath = this.currentKeyPath();
            const ageKeyGenPath = this.agePath.endsWith('age') ? this.agePath.replace(/age$/, 'age-keygen') : 'age-keygen';
            const child = spawn(ageKeyGenPath, ['-o', keyPath]);
            child.on('exit', (code) => code === 0 ? resolve() : reject(new Error(`age-keygen exited with code ${code}`)));
        });
    }

    async getPublicKey(): Promise<string> {
        const keyPath = this.currentKeyPath();
        if (!fs.existsSync(keyPath)) return "";
        const content = fs.readFileSync(keyPath, 'utf8');
        const match = content.match(/# public key: (age1[a-z0-9]+)/);
        return (match && match[1]) ? match[1] : "";
    }

    private async loadCommitMap(): Promise<Map<string, string>> {
        const map = new Map<string, string>();
        if (fs.existsSync(this.commitMapPath())) {
            const content = fs.readFileSync(this.commitMapPath(), 'utf8');
            content.split('\n').forEach(line => {
                const [plain, enc] = line.split(':');
                if (plain && enc) map.set(plain, enc);
            });
        }
        return map;
    }

    private async saveCommitMap(map: Map<string, string>): Promise<void> {
        let content = "";
        for (const [plain, enc] of map.entries()) {
            content += `${plain}:${enc}\n`;
        }
        fs.writeFileSync(this.commitMapPath(), content, 'utf8');
    }

    async getUnsyncedCommitCount(): Promise<number> {
        const commitMap = await this.loadCommitMap();
        try {
            const logs = await this.git.log(['--reverse']);
            return logs.all.filter(commit => !commitMap.has(commit.hash)).length;
        } catch {
            return 0; // If git log fails, return 0
        }
    }

    stopSync(): void {
        this.isAborted = true;
    }

    async sync(onProgress?: (synced: number, total: number) => void): Promise<number> {
        this.isAborted = false;
        if (fs.existsSync(this.lockPath())) {
            throw new Error("Sync is already in progress (lock file exists)");
        }

        fs.writeFileSync(this.lockPath(), "locked", "utf8");

        const tempDir = fs.mkdtempSync(path.join(path.dirname(this.encryptedRepoPath()), 'lc-workspace-'));
        try {
            const config = await this.loadConfig();
            const publicKey = await this.getPublicKey();
            if (!publicKey) throw new Error("No public key found. Please initialize settings.");

            const commitMap = await this.loadCommitMap();
            const logs = await this.git.log(['--reverse']);
            const allPlainCommits = logs.all;

            const commitsToSync = allPlainCommits.filter(commit => !commitMap.has(commit.hash));
            const totalToSync = commitsToSync.length;
            let syncedCount = 0;

            if (totalToSync === 0) return 0;
            if (onProgress) onProgress(0, totalToSync);

            // 1. Prepare Workspace
            const tempGit = simpleGit(tempDir, { binary: this.gitPath });
            const encRepoPath = this.encryptedRepoPath();

            // Check if mirror is empty
            const encRepo = simpleGit(encRepoPath, { binary: this.gitPath });
            const encLogs = await encRepo.log().catch(() => ({ total: 0 }));

            if (encLogs.total > 0) {
                await tempGit.clone(encRepoPath, tempDir);
            } else {
                await tempGit.init();
                await tempGit.addRemote('origin', encRepoPath);
            }

            // 2. Linear Sync Loop
            let incrementalCount = 0;
            for (const commit of commitsToSync) {
                if (this.isAborted) {
                    // Save progress before aborting
                    const status = await tempGit.status();
                    if (status.ahead > 0) {
                        await tempGit.push('origin', 'HEAD').catch(() => { });
                    }
                    await this.saveCommitMap(commitMap);
                    throw new Error("Sync aborted by user");
                }

                // Get files changed in this specific commit
                const files = await this.git.show(['--name-only', '--pretty=format:', commit.hash]);
                const fileList = files.split('\n').filter(f => f.trim() !== "" && !this.isExcluded(f, config.exclude_patterns));

                // Process files
                for (const file of fileList) {
                    const fullPath = path.join(this.vaultPath, file);
                    const targetPath = path.join(tempDir, file + '.age');

                    if (fs.existsSync(fullPath)) {
                        const stats = fs.statSync(fullPath);
                        if (stats.isDirectory()) continue;

                        const content = fs.readFileSync(fullPath);
                        const encrypted = await this.ageEncrypt(content, publicKey);
                        fs.mkdirSync(path.dirname(targetPath), { recursive: true });
                        fs.writeFileSync(targetPath, encrypted);
                    } else {
                        // File was deleted in this commit
                        if (fs.existsSync(targetPath)) fs.unlinkSync(targetPath);
                    }
                }

                await tempGit.add('.');
                // Check if there are changes to commit (empty commits might happen if all files excluded)
                const status = await tempGit.status();
                if (status.files.length > 0 || status.staged.length > 0) {
                    await tempGit.commit(commit.message, { '--date': commit.date });
                    const newEncLogs = await tempGit.log();
                    const encHash = newEncLogs.latest?.hash;
                    if (encHash) {
                        commitMap.set(commit.hash, encHash);
                    }
                } else {
                    // Map to the previous encrypted commit if this one is effectively empty
                    const lastEncLogs = await tempGit.log().catch(() => ({ latest: null }));
                    if (lastEncLogs.latest) {
                        commitMap.set(commit.hash, lastEncLogs.latest.hash);
                    }
                }

                syncedCount++;
                incrementalCount++;

                // Incremental save and push to local mirror
                if (incrementalCount >= 5) {
                    const status = await tempGit.status();
                    if (status.ahead > 0) {
                        await tempGit.push('origin', 'HEAD');
                    }
                    await this.saveCommitMap(commitMap);
                    incrementalCount = 0;
                }

                if (onProgress) onProgress(syncedCount, totalToSync);
            }

            // 3. Finalize
            const finalStatus = await tempGit.status();
            if (finalStatus.ahead > 0) {
                await tempGit.push('origin', 'HEAD');
            }
            await this.saveCommitMap(commitMap);
            return syncedCount;
        } finally {
            fs.rmSync(tempDir, { recursive: true, force: true });
            if (fs.existsSync(this.lockPath())) fs.unlinkSync(this.lockPath());
        }
    }

    private isExcluded(filePath: string, patterns: string[]): boolean {
        const base = path.basename(filePath);
        return patterns.some(p => base === p || filePath.startsWith(p));
    }

    private async ageEncrypt(plaintext: Buffer, publicKey: string): Promise<Buffer> {
        return new Promise((resolve, reject) => {
            const child = spawn(this.agePath, ['-r', publicKey]);
            const chunks: Buffer[] = [];
            let stderr = "";

            const timeout = setTimeout(() => {
                child.kill();
                reject(new Error("age encryption timed out after 30s"));
            }, 30000);

            child.stdout.on('data', (chunk: Buffer) => chunks.push(chunk));
            child.stderr.on('data', (data: Buffer) => { stderr += data.toString(); });

            child.on('exit', (code) => {
                clearTimeout(timeout);
                if (code === 0) {
                    resolve(Buffer.concat(chunks));
                } else {
                    reject(new Error(`age encryption failed (code ${code}): ${stderr}`));
                }
            });

            child.on('error', (err) => {
                clearTimeout(timeout);
                reject(err);
            });

            child.stdin.write(plaintext);
            child.stdin.end();
        });
    }

    async push(): Promise<void> {
        if (fs.existsSync(this.lockPath())) {
            throw new Error("Action is already in progress (lock file exists)");
        }
        fs.writeFileSync(this.lockPath(), "locked", "utf8");

        try {
            const config = await this.loadConfig();
            if (!config.encrypted_remote.url) throw new Error("Encrypted remote URL not configured");

            const encRepo = simpleGit(this.encryptedRepoPath(), { binary: this.gitPath });
            const remotes = await encRepo.getRemotes();
            if (!remotes.some(r => r.name === config.encrypted_remote.name)) {
                await encRepo.addRemote(config.encrypted_remote.name, config.encrypted_remote.url);
            } else {
                // Update URL if changed
                await encRepo.remote(['set-url', config.encrypted_remote.name, config.encrypted_remote.url]);
            }

            await encRepo.push(config.encrypted_remote.name, 'HEAD');
        } finally {
            if (fs.existsSync(this.lockPath())) fs.unlinkSync(this.lockPath());
        }
    }

    async pull(): Promise<void> {
        const config = await this.loadConfig();
        if (!config.encrypted_remote.url) throw new Error("Encrypted remote URL not configured");

        const encRepo = simpleGit(this.encryptedRepoPath(), { binary: this.gitPath });
        const remotes = await encRepo.getRemotes();
        if (!remotes.some(r => r.name === config.encrypted_remote.name)) {
            await encRepo.addRemote(config.encrypted_remote.name, config.encrypted_remote.url);
        }

        await encRepo.pull(config.encrypted_remote.name, 'HEAD');
    }

    async decryptSync(onProgress?: (synced: number, total: number) => void): Promise<number> {
        this.isAborted = false;
        if (fs.existsSync(this.lockPath())) {
            throw new Error("Action is already in progress (lock file exists)");
        }
        fs.writeFileSync(this.lockPath(), "locked", "utf8");

		try {
			await this.loadConfig();
			const commitMap = await this.loadCommitMap();
			// Reverse map to find encrypted SHAs that have been synced
            const syncedEncSHAs = new Set(Array.from(commitMap.values()));

            const encRepo = simpleGit(this.encryptedRepoPath(), { binary: this.gitPath });
            const encLogs = await encRepo.log(['--reverse']).catch(() => ({ all: [] }));
            const encCommits = encLogs.all;

            const commitsToDecrypt = encCommits.filter(c => !syncedEncSHAs.has(c.hash));
            const totalToDecrypt = commitsToDecrypt.length;
            let decryptedCount = 0;

            if (totalToDecrypt === 0) return 0;
            if (onProgress) onProgress(0, totalToDecrypt);

            for (const encCommit of commitsToDecrypt) {
                if (this.isAborted) throw new Error("Sync aborted by user");

                // Get list of ALL files in this encrypted commit
                const filesAtCommit = await encRepo.raw(['ls-tree', '-r', '--name-only', encCommit.hash]);
                const allFiles = filesAtCommit.split('\n').filter(f => f.trim().endsWith('.age'));

                // To handle deletions effectively, we should ideally know what changed.
                // But for recovery, we can just ensure the files in this commit exist.
                // However, to perfectly mirror, we should see what was deleted in the encrypted repo.
                // For now, let's focus on extracting what's there.

                for (const file of allFiles) {
                    // Use spawn to get binary content from bare repo safely
                    const contentBuffer = await new Promise<Buffer>((resolve, reject) => {
                        const child = spawn(this.gitPath, ['-C', this.encryptedRepoPath(), 'show', `${encCommit.hash}:${file}`]);
                        const chunks: Buffer[] = [];
                        child.stdout.on('data', (chunk: Buffer) => chunks.push(chunk));
                        child.on('exit', (code) => code === 0 ? resolve(Buffer.concat(chunks)) : reject(new Error(`git show failed with code ${code}`)));
                        child.on('error', reject);
                    });

                    const decrypted = await this.ageDecrypt(contentBuffer);

                    const relativePlainPath = file.replace(/\.age$/, '');
                    const fullPlainPath = path.join(this.vaultPath, relativePlainPath);
                    fs.mkdirSync(path.dirname(fullPlainPath), { recursive: true });
                    fs.writeFileSync(fullPlainPath, decrypted);
                }

                await this.git.add('.');
                await this.git.commit(encCommit.message, { '--date': encCommit.date });

                const plainLogs = await this.git.log();
                const plainHash = plainLogs.latest?.hash;
                if (plainHash) {
                    commitMap.set(plainHash, encCommit.hash);
                    decryptedCount++;
                    if (onProgress) onProgress(decryptedCount, totalToDecrypt);
                }
            }

            await this.saveCommitMap(commitMap);
            return decryptedCount;
        } finally {
            if (fs.existsSync(this.lockPath())) fs.unlinkSync(this.lockPath());
        }
    }

    private async ageDecrypt(encrypted: Buffer): Promise<Buffer> {
        const keyPath = this.currentKeyPath();
        if (!fs.existsSync(keyPath)) throw new Error("Private key not found");

        return new Promise((resolve, reject) => {
            const child = spawn(this.agePath, ['-d', '-i', keyPath]);
            const chunks: Buffer[] = [];
            let stderr = "";

            const timeout = setTimeout(() => {
                child.kill();
                reject(new Error("age decryption timed out after 30s"));
            }, 30000);

            child.stdout.on('data', (chunk: Buffer) => chunks.push(chunk));
            child.stderr.on('data', (data: Buffer) => { stderr += data.toString(); });

            child.on('exit', (code) => {
                clearTimeout(timeout);
                if (code === 0) {
                    resolve(Buffer.concat(chunks));
                } else {
                    reject(new Error(`age decryption failed (code ${code}): ${stderr}`));
                }
            });

            child.on('error', (err) => {
                clearTimeout(timeout);
                reject(err);
            });

            child.stdin.write(encrypted);
            child.stdin.end();
        });
    }
}
