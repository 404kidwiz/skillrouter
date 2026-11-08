import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
// Own process so HOME is redirected before paths.js loads and the index cache starts empty.
const home = fs.mkdtempSync(path.join(os.tmpdir(), "skillrouter-core-idem-"));
process.env.HOME = home;
process.env.USERPROFILE = home;
process.env.SKILLROUTER_HOME = path.join(home, ".skillrouter");
const { writeCore, syncCore } = await import("../src/core.js");
const { buildIndex, saveIndex } = await import("../src/index.js");
test("core sync is idempotent when a core id differs from its folder name", () => {
    const lib = path.join(home, "lib");
    fs.mkdirSync(path.join(lib, "scrollcraft"), { recursive: true });
    fs.writeFileSync(path.join(lib, "scrollcraft", "SKILL.md"), "---\nname: scroll-craft\ndescription: scroll pages\n---\n");
    saveIndex(buildIndex([lib]));
    writeCore(["scroll-craft"]);
    syncCore(["claude", "codex"]);
    const link = path.join(home, ".claude", "skills", "scrollcraft");
    const ino = fs.lstatSync(link).ino;
    const again = syncCore(["claude", "codex"]);
    assert.equal(again.unlinked, 0); // unpatched: 2 on every run (link names compared with core ids)
    assert.equal(fs.lstatSync(link).ino, ino); // not deleted and re-created
    // Removing it from core still removes the links core sync made.
    writeCore([]);
    assert.equal(syncCore(["claude", "codex"]).unlinked, 2);
    assert.equal(fs.existsSync(link), false);
});
