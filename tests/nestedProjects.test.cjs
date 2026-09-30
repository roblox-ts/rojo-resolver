const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { afterEach, beforeEach, test } = require("node:test");
const { RojoResolver } = require("../out/RojoResolver");

let directory;
beforeEach(() => {
	directory = fs.mkdtempSync(path.join(os.tmpdir(), "rojo-resolver-"));
});
afterEach(() => fs.rmSync(directory, { recursive: true, force: true }));

function json(relative, value) {
	const file = path.join(directory, relative);
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, JSON.stringify(value));
	return file;
}

function project(tree) {
	return RojoResolver.fromPath(
		json("default.project.json", { name: "root", tree }),
	);
}

function mapped(resolver, relative) {
	return resolver.getRbxPathFromFilePath(path.join(directory, relative));
}

test("mounts a project tree at its explicit name and resolves paths relative to that project", () => {
	json("nested/library.project.json", {
		name: "unused-name",
		tree: {
			source: { $path: "../out" },
			child: { $path: "deeper/child.project.json" },
		},
	});
	json("nested/deeper/child.project.json", {
		name: "also-unused",
		tree: { $path: "../../child-out" },
	});
	const resolver = project({
		mounted: { $path: "nested/library.project.json" },
	});

	assert.deepEqual(mapped(resolver, "out/init.lua"), ["mounted", "source"]);
	assert.deepEqual(mapped(resolver, "out/value.luau"), [
		"mounted",
		"source",
		"value",
	]);
	assert.deepEqual(mapped(resolver, "child-out/value.luau"), [
		"mounted",
		"child",
		"value",
	]);
	assert.equal(mapped(resolver, "nested/library.project.json"), undefined);
	assert.deepEqual(resolver.getWarnings(), []);
});

test("accepts an optional project before and after it is created", () => {
	const tree = {
		mounted: { $path: { optional: "generated/library.project.json" } },
	};
	const missing = project(tree);
	assert.deepEqual(missing.getWarnings(), []);
	assert.equal(mapped(missing, "generated/library.project.json"), undefined);

	json("generated/library.project.json", {
		name: "library",
		tree: { $path: "../out" },
	});
	assert.deepEqual(mapped(project(tree), "out/value.luau"), [
		"mounted",
		"value",
	]);
});

test("allows repeated mounts without treating the second mount as a cycle", () => {
	json("library.project.json", { name: "library", tree: { $path: "out" } });
	const resolver = project({
		first: { $path: "library.project.json" },
		second: { $path: "library.project.json" },
	});
	assert.deepEqual(mapped(resolver, "out/value.luau"), ["second", "value"]);
});

test("preserves ordinary JSON modules, including an empty project basename", () => {
	json("data.json", { value: 1 });
	json(".project.json", { value: 2 });
	const resolver = project({
		data: { $path: "data.json" },
		empty: { $path: ".project.json" },
	});
	assert.deepEqual(mapped(resolver, "data.json"), ["data"]);
	assert.deepEqual(mapped(resolver, ".project.json"), ["empty"]);
});

test("preserves directory discovery of default projects", () => {
	json("nested/default.project.json", {
		name: "library",
		tree: { $path: "../out" },
	});
	assert.deepEqual(
		mapped(project({ mounted: { $path: "nested" } }), "out/value.luau"),
		["mounted", "value"],
	);
});

test("reports invalid nested projects and throws for malformed JSON", () => {
	json("invalid.project.json", { invalid: true });
	assert.match(
		project({
			mounted: { $path: "invalid.project.json" },
		}).getWarnings()[0],
		/Invalid configuration/,
	);
	fs.writeFileSync(path.join(directory, "invalid.project.json"), "{");
	assert.throws(
		() => project({ mounted: { $path: "invalid.project.json" } }),
		SyntaxError,
	);
});

test("warns for a missing root project instead of failing realpath", () => {
	const missing = path.join(directory, "missing.project.json");
	assert.deepEqual(RojoResolver.fromPath(missing).getWarnings(), [
		`RojoResolver: Path does not exist "${missing}"`,
	]);
});
