import Ajv from "ajv";
import fs from "fs-extra";
import path from "path";

const PACKAGE_ROOT = path.join(__dirname, "..");

const LUA_EXT = ".lua";
const LUAU_EXT = ".luau";
const JSON_EXT = ".json";
const TOML_EXT = ".toml";

const ROJO_MODULE_EXTS = new Set([LUA_EXT, LUAU_EXT, JSON_EXT, TOML_EXT]);
const ROJO_SCRIPT_EXTS = new Set([LUA_EXT, LUAU_EXT]);

const INIT_NAME = "init";

const SERVER_SUBEXT = ".server";
const CLIENT_SUBEXT = ".client";
const MODULE_SUBEXT = "";

interface RojoTreeProperty {
	Type: string;
	Value: unknown;
}

interface RojoTreeMetadata {
	$className?: string;
	$path?: string | { optional: string };
	$properties?: Array<RojoTreeProperty>;
	$ignoreUnknownInstances?: boolean;
}

type RojoTree = RojoTreeMetadata & RojoTreeMembers;

interface RojoTreeMembers {
	[name: string]: RojoTree;
}

interface RojoFile {
	servePort?: number;
	name: string;
	tree: RojoTree;
}

const ajv = new Ajv();

const ROJO_FILE_REGEX = /^.+\.project\.json$/;
const ROJO_DEFAULT_NAME = "default.project.json";
const ROJO_OLD_NAME = "roblox-project.json";

export enum RbxType {
	ModuleScript,
	Script,
	LocalScript,
	Unknown,
}

const SUB_EXT_TYPE_MAP = new Map<string, RbxType>([
	[MODULE_SUBEXT, RbxType.ModuleScript],
	[SERVER_SUBEXT, RbxType.Script],
	[CLIENT_SUBEXT, RbxType.LocalScript],
]);

const DEFAULT_ISOLATED_CONTAINERS: Array<RbxPath> = [
	["StarterPack"],
	["StarterGui"],
	["StarterPlayer", "StarterPlayerScripts"],
	["StarterPlayer", "StarterCharacterScripts"],
	["StarterPlayer", "StarterCharacter"],
	["PluginDebugService"],
];

const CLIENT_CONTAINERS = [["StarterPack"], ["StarterGui"], ["StarterPlayer"]];
const SERVER_CONTAINERS = [["ServerStorage"], ["ServerScriptService"]];

/**
 * Represents a roblox tree path.
 */
export type RbxPath = ReadonlyArray<string>;
export type RelativeRbxPath = ReadonlyArray<string | RbxPathParent>;

interface PartitionInfo {
	rbxPath: RbxPath;
	fsPath: string;
}

export enum FileRelation {
	OutToOut, // absolute
	OutToIn, // error
	InToOut, // absolute
	InToIn, // relative
}

export enum NetworkType {
	Unknown,
	Client,
	Server,
}

function stripRojoExts(filePath: string) {
	const ext = path.extname(filePath);
	if (ROJO_MODULE_EXTS.has(ext)) {
		filePath = filePath.slice(0, -ext.length);
		if (ROJO_SCRIPT_EXTS.has(ext)) {
			const subext = path.extname(filePath);
			if (subext === SERVER_SUBEXT || subext === CLIENT_SUBEXT) {
				filePath = filePath.slice(0, -subext.length);
			}
		}
	}
	return filePath;
}

function arrayStartsWith<T>(a: ReadonlyArray<T>, b: ReadonlyArray<T>) {
	const minLength = Math.min(a.length, b.length);
	for (let i = 0; i < minLength; i++) {
		if (a[i] !== b[i]) {
			return false;
		}
	}
	return true;
}

function isPathDescendantOf(filePath: string, dirPath: string) {
	return dirPath === filePath || !path.relative(dirPath, filePath).startsWith("..");
}

class Lazy<T> {
	private isInitialized = false;
	private value: T | undefined;

	constructor(private readonly getValue: () => T) {}

	public get() {
		if (!this.isInitialized) {
			this.isInitialized = true;
			this.value = this.getValue();
		}
		return this.value as T;
	}

	public set(value: T) {
		this.isInitialized = true;
		this.value = value;
	}
}

const SCHEMA_PATH = path.join(PACKAGE_ROOT, "rojo-schema.json");
const validateRojo = new Lazy(() => ajv.compile(JSON.parse(fs.readFileSync(SCHEMA_PATH).toString())));
function isValidRojoConfig(value: unknown): value is RojoFile {
	return validateRojo.get()(value) === true;
}

export const RbxPathParent = Symbol("Parent");
export type RbxPathParent = typeof RbxPathParent;

export class RojoResolver {
	public static findRojoConfigFilePath(projectPath: string) {
		const warnings = new Array<string>();

		const defaultPath = path.join(projectPath, ROJO_DEFAULT_NAME);
		if (fs.pathExistsSync(defaultPath)) {
			return { path: defaultPath, warnings };
		}

		const candidates = new Array<string | undefined>();
		for (const fileName of fs.readdirSync(projectPath)) {
			if (fileName !== ROJO_DEFAULT_NAME && (fileName === ROJO_OLD_NAME || ROJO_FILE_REGEX.test(fileName))) {
				candidates.push(path.join(projectPath, fileName));
			}
		}

		if (candidates.length > 1) {
			warnings.push(`Multiple *.project.json files found, using ${candidates[0]}`);
		}
		return { path: candidates[0], warnings };
	}

	private warnings = new Array<string>();

	private constructor() {}

	private warn(str: string) {
		this.warnings.push(str);
	}

	public getWarnings(): ReadonlyArray<string> {
		return this.warnings;
	}

	public static fromPath(rojoConfigFilePath: string) {
		const resolver = new RojoResolver();
		resolver.parseConfig(path.resolve(rojoConfigFilePath), true);
		return resolver;
	}

	/**
	 * Create a synthetic RojoResolver for ProjectType.Package.
	 * Forces all imports to be relative.
	 */
	public static synthetic(basePath: string) {
		const resolver = new RojoResolver();
		resolver.parseTree(basePath, "", { $path: basePath } as RojoTree, true);
		return resolver;
	}

	public static fromTree(basePath: string, tree: RojoTree) {
		const resolver = new RojoResolver();
		resolver.parseTree(basePath, "", tree, true);
		return resolver;
	}

	private rbxPath = new Array<string>();
	private partitions = new Array<PartitionInfo>();
	private filePathToRbxPathMap = new Map<string, RbxPath>();
	private isolatedContainers = [...DEFAULT_ISOLATED_CONTAINERS];
	public isGame = false;

	private parseConfig(rojoConfigFilePath: string, doNotPush = false) {
		const realPath = fs.realpathSync(rojoConfigFilePath);
		if (fs.pathExistsSync(realPath)) {
			let configJson: unknown;
			try {
				configJson = JSON.parse(fs.readFileSync(realPath).toString());
			} finally {
				if (isValidRojoConfig(configJson)) {
					this.parseTree(path.dirname(rojoConfigFilePath), configJson.name, configJson.tree, doNotPush);
				} else {
					this.warn(`RojoResolver: Invalid configuration! ${ajv.errorsText(validateRojo.get().errors)}`);
				}
			}
		} else {
			this.warn(`RojoResolver: Path does not exist "${rojoConfigFilePath}"`);
		}
	}

	private parseTree(basePath: string, name: string, tree: RojoTree, doNotPush = false) {
		if (!doNotPush) this.rbxPath.push(name);

		if (tree.$path !== undefined) {
			this.parsePath(path.resolve(basePath, typeof tree.$path === "string" ? tree.$path : tree.$path.optional));
		}

		if (tree.$className === "DataModel") {
			this.isGame = true;
		}

		for (const childName of Object.keys(tree).filter(v => !v.startsWith("$"))) {
			this.parseTree(basePath, childName, tree[childName]);
		}

		if (!doNotPush) this.rbxPath.pop();
	}

	private parsePath(itemPath: string) {
		const realPath = fs.pathExistsSync(itemPath) ? fs.realpathSync(itemPath) : itemPath;
		const ext = path.extname(itemPath);
		if (ROJO_MODULE_EXTS.has(ext)) {
			this.filePathToRbxPathMap.set(itemPath, [...this.rbxPath]);
		} else {
			const isDirectory = fs.pathExistsSync(realPath) && fs.statSync(realPath).isDirectory();
			if (isDirectory && fs.readdirSync(realPath).includes(ROJO_DEFAULT_NAME)) {
				this.parseConfig(path.join(itemPath, ROJO_DEFAULT_NAME), true);
			} else {
				this.partitions.unshift({
					fsPath: itemPath,
					rbxPath: [...this.rbxPath],
				});

				if (isDirectory) {
					this.searchDirectory(itemPath);
				}
			}
		}
	}

	private searchDirectory(directory: string, item?: string) {
		const realPath = fs.realpathSync(directory);
		const children = fs.readdirSync(realPath);

		if (children.includes(ROJO_DEFAULT_NAME)) {
			this.parseConfig(path.join(directory, ROJO_DEFAULT_NAME));
			return;
		}

		if (item) this.rbxPath.push(item);

		// *.project.json
		for (const child of children) {
			const childPath = path.join(directory, child);
			const childRealPath = fs.realpathSync(childPath);
			if (fs.statSync(childRealPath).isFile() && child !== ROJO_DEFAULT_NAME && ROJO_FILE_REGEX.test(child)) {
				this.parseConfig(childPath);
			}
		}

		// folders
		for (const child of children) {
			const childPath = path.join(directory, child);
			const childRealPath = fs.realpathSync(childPath);
			if (fs.statSync(childRealPath).isDirectory()) {
				this.searchDirectory(childPath, child);
			}
		}

		if (item) this.rbxPath.pop();
	}

	public getRbxPathFromFilePath(filePath: string): RbxPath | undefined {
		filePath = path.resolve(filePath);
		const rbxPath = this.filePathToRbxPathMap.get(filePath);
		if (rbxPath) {
			return rbxPath;
		}

		const ext = path.extname(filePath);
		for (const partition of this.partitions) {
			if (isPathDescendantOf(filePath, partition.fsPath)) {
				const stripped = stripRojoExts(filePath);
				const relativePath = path.relative(partition.fsPath, stripped);
				const relativeParts = relativePath === "" ? [] : relativePath.split(path.sep);
				if (ROJO_SCRIPT_EXTS.has(ext) && relativeParts.at(-1) === INIT_NAME) {
					relativeParts.pop();
				}
				return partition.rbxPath.concat(relativeParts);
			}
		}
	}

	public getRbxTypeFromFilePath(filePath: string): RbxType {
		const subext = path.extname(path.basename(filePath, path.extname(filePath)));
		return SUB_EXT_TYPE_MAP.get(subext) ?? RbxType.Unknown;
	}

	private getContainer(from: Array<RbxPath>, rbxPath?: RbxPath) {
		if (this.isGame) {
			if (rbxPath) {
				for (const container of from) {
					if (arrayStartsWith(rbxPath, container)) {
						return container;
					}
				}
			}
		}
	}

	public getFileRelation(fileRbxPath: RbxPath, moduleRbxPath: RbxPath): FileRelation {
		const fileContainer = this.getContainer(this.isolatedContainers, fileRbxPath);
		const moduleContainer = this.getContainer(this.isolatedContainers, moduleRbxPath);
		if (fileContainer && moduleContainer) {
			if (fileContainer === moduleContainer) {
				return FileRelation.InToIn;
			} else {
				return FileRelation.OutToIn;
			}
		} else if (fileContainer && !moduleContainer) {
			return FileRelation.InToOut;
		} else if (!fileContainer && moduleContainer) {
			return FileRelation.OutToIn;
		} else {
			// !fileContainer && !moduleContainer
			return FileRelation.OutToOut;
		}
	}

	public isIsolated(rbxPath: RbxPath) {
		return this.getContainer(this.isolatedContainers, rbxPath) !== undefined;
	}

	public getNetworkType(rbxPath: RbxPath): NetworkType {
		if (this.getContainer(SERVER_CONTAINERS, rbxPath)) {
			return NetworkType.Server;
		}
		if (this.getContainer(CLIENT_CONTAINERS, rbxPath)) {
			return NetworkType.Client;
		}
		return NetworkType.Unknown;
	}

	public static relative(rbxFrom: RbxPath, rbxTo: RbxPath): RelativeRbxPath {
		const maxLength = Math.max(rbxFrom.length, rbxTo.length);
		let diffIndex = maxLength;
		for (let i = 0; i < maxLength; i++) {
			if (rbxFrom[i] !== rbxTo[i]) {
				diffIndex = i;
				break;
			}
		}

		const result = new Array<string | RbxPathParent>();
		if (diffIndex < rbxFrom.length) {
			for (let i = 0; i < rbxFrom.length - diffIndex; i++) {
				result.push(RbxPathParent);
			}
		}

		for (let i = diffIndex; i < rbxTo.length; i++) {
			result.push(rbxTo[i]);
		}

		return result;
	}

	public getPartitions(): ReadonlyArray<PartitionInfo> {
		return this.partitions;
	}
}
