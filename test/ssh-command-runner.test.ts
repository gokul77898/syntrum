import assert from "node:assert/strict";
import test from "node:test";

import { createSshCommandRunner } from "../src/cloud/ssh-command-runner.js";

const run = createSshCommandRunner({ host: "worker.example", user: "operator" });

test("SSH worker redirects stdin, preserves output errors and safely quotes argv", async () => {
  const calls = [];
  const execute = (file, args, options, callback) => {
    calls.push({ file, args, options });
    if (args.at(-1) === "'failure'") {
      callback(new Error("exit 1"), "", "permission denied\n");
    } else if (args.at(-1) === "'stdout-failure'") {
      callback(new Error("exit 1"), "volume is busy\n", "");
    } else if (args.at(-1) === "'empty-failure'") {
      callback(new Error("Command failed: ssh ...\n"), "", "");
    } else {
      callback(null, "ok\n", "");
    }
  };

  assert.equal(await run(["success", "arg with spaces", "single'quote"], 1500, execute), "ok");
  assert.equal(calls[0].file, "ssh");
  assert.equal(calls[0].args[0], "-n");
  assert.ok(calls[0].args.includes("StrictHostKeyChecking=yes"));
  assert.ok(calls[0].args.includes("'arg with spaces'"));
  assert.equal(calls[0].args.at(-1), `'single'"'"'quote'`);
  assert.equal(calls[0].options.shell, false);
  await assert.rejects(run(["failure"], 1500, execute), /permission denied/);
  await assert.rejects(run(["stdout-failure"], 1500, execute), /volume is busy/);
  await assert.rejects(run(["empty-failure"], 1500, execute), /Remote command failed/);
});
