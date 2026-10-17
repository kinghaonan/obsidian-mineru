import { normalizePath, TFile, TFolder } from "obsidian";

/** 造一个只带 path 的 TFile（name/basename/extension 由 stub 按 path 推导） */
export function makeTFile(path: string): TFile {
	const file = new TFile();
	file.path = normalizePath(path);
	return file;
}

/** 内存版 Vault，仅实现插件实际用到的能力 */
export interface MemoryVault {
	readonly entries: Map<string, { file: TFile; data: Uint8Array }>;
	readonly folders: Set<string>;
	readonly createdFolders: string[];
	readBinary(file: TFile): Promise<ArrayBuffer>;
	read(file: TFile): Promise<string>;
	create(path: string, content: string): Promise<TFile>;
	createBinary(path: string, data: ArrayBuffer): Promise<TFile>;
	modify(file: TFile, content: string): Promise<void>;
	modifyBinary(file: TFile, data: ArrayBuffer): Promise<void>;
	createFolder(path: string): Promise<void>;
	getAbstractFileByPath(path: string): TFile | TFolder | null;
	getFiles(): TFile[];
	seed(path: string, content: string | Uint8Array): TFile;
}

export function createVault(): MemoryVault {
	const entries = new Map<string, { file: TFile; data: Uint8Array }>();
	const folders = new Set<string>([""]);
	const createdFolders: string[] = [];

	const enc = new TextEncoder();
	const dec = new TextDecoder();

	function makeFile(path: string): TFile {
		const file = new TFile();
		file.path = normalizePath(path);
		(file as { vault?: unknown }).vault = vault;
		return file;
	}

	const vault: MemoryVault = {
		entries,
		folders,
		createdFolders,

		seed(path, content) {
			const p = normalizePath(path);
			const data = typeof content === "string" ? enc.encode(content) : content;
			const file = makeFile(p);
			entries.set(p, { file, data });
			return file;
		},

		async readBinary(file) {
			const hit = entries.get(normalizePath(file.path));
			if (!hit) throw new Error(`文件不存在：${file.path}`);
			const copy = hit.data.slice();
			return copy.buffer.slice(copy.byteOffset, copy.byteOffset + copy.byteLength) as ArrayBuffer;
		},

		async read(file) {
			return dec.decode(await vault.readBinary(file));
		},

		async create(path, content) {
			const p = normalizePath(path);
			if (entries.has(p)) throw new Error(`文件已存在：${p}`);
			const file = makeFile(p);
			entries.set(p, { file, data: enc.encode(content) });
			return file;
		},

		async createBinary(path, data) {
			const p = normalizePath(path);
			if (entries.has(p)) throw new Error(`文件已存在：${p}`);
			const file = makeFile(p);
			entries.set(p, { file, data: new Uint8Array(data) });
			return file;
		},

		async modify(file, content) {
			const hit = entries.get(normalizePath(file.path));
			if (!hit) throw new Error(`文件不存在：${file.path}`);
			hit.data = enc.encode(content);
		},

		async modifyBinary(file, data) {
			const hit = entries.get(normalizePath(file.path));
			if (!hit) throw new Error(`文件不存在：${file.path}`);
			hit.data = new Uint8Array(data);
		},

		async createFolder(path) {
			const p = normalizePath(path);
			if (!p || folders.has(p)) throw new Error(`文件夹已存在：${p}`);
			folders.add(p);
			createdFolders.push(p);
		},

		getAbstractFileByPath(path) {
			const p = normalizePath(path);
			if (entries.has(p)) return entries.get(p)!.file;
			if (folders.has(p)) {
				const folder = new TFolder();
				folder.path = p;
				return folder;
			}
			return null;
		},

		getFiles() {
			return [...entries.values()].map((e) => e.file);
		},
	};

	return vault;
}

/** 满足 Translator / pipeline 所需的最小 App 形状 */
export interface MemoryApp {
	vault: MemoryVault;
	opened: TFile[];
	workspace: {
		opened: TFile[];
		getLeaf(): { openFile(file: TFile): Promise<void> };
	};
}

export function createApp(vault: MemoryVault): MemoryApp {
	const opened: TFile[] = [];
	return {
		vault,
		opened,
		workspace: {
			opened,
			getLeaf() {
				return {
					async openFile(file: TFile) {
						opened.push(file);
					},
				};
			},
		},
	};
}