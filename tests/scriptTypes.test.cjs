const assert = require("node:assert/strict");
const path = require("node:path");
const { test } = require("node:test");
const { RbxType, RojoResolver } = require("../out/RojoResolver");

const root = path.resolve("fixtures");
const resolver = RojoResolver.synthetic(root);

for (const extension of ["lua", "luau"]) {
	for (const name of [
		"module",
		"module.require",
		"module.with.multiple.dots",
		"module.server.require",
		"module.client.require",
	]) {
		test(`classifies ${name}.${extension} as a ModuleScript`, () => {
			const filePath = path.join(root, `${name}.${extension}`);

			assert.equal(resolver.getRbxTypeFromFilePath(filePath), RbxType.ModuleScript);
			assert.deepEqual(resolver.getRbxPathFromFilePath(filePath), [name]);
		});
	}

	for (const [suffix, type] of [
		["server", RbxType.Script],
		["client", RbxType.LocalScript],
	]) {
		for (const name of ["module", "module.require"]) {
			test(`classifies ${name}.${suffix}.${extension} as a ${RbxType[type]}`, () => {
				const filePath = path.join(root, `${name}.${suffix}.${extension}`);

				assert.equal(resolver.getRbxTypeFromFilePath(filePath), type);
				assert.deepEqual(resolver.getRbxPathFromFilePath(filePath), [name]);
			});
		}
	}

	for (const [name, type] of [
		["init", RbxType.ModuleScript],
		["init.server", RbxType.Script],
		["init.client", RbxType.LocalScript],
	]) {
		test(`classifies ${name}.${extension} as a directory script`, () => {
			const filePath = path.join(root, "folder", `${name}.${extension}`);

			assert.equal(resolver.getRbxTypeFromFilePath(filePath), type);
			assert.deepEqual(resolver.getRbxPathFromFilePath(filePath), ["folder"]);
		});
	}
}

for (const extension of ["json", "toml"]) {
	for (const name of ["module", "module.server", "module.client"]) {
		test(`classifies ${name}.${extension} as a data module`, () => {
			const filePath = path.join(root, `${name}.${extension}`);

			assert.equal(resolver.getRbxTypeFromFilePath(filePath), RbxType.ModuleScript);
			assert.deepEqual(resolver.getRbxPathFromFilePath(filePath), [name]);
		});
	}
}
