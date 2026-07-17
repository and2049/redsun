import { expect, test } from "bun:test"
import { Instance } from "../../src/project/instance"
import { Session } from "../../src/session"
import { assertSubagentDepth } from "../../src/tool/task"
import { tmpdir } from "../fixture/fixture"

test("subagent depth defaults to one level and permits an explicit larger limit", async () => {
  await using tmp = await tmpdir()
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const root = await Session.create({})
      const child = await Session.create({ parentID: root.id })
      await expect(assertSubagentDepth(root.id, 1)).resolves.toBeUndefined()
      await expect(assertSubagentDepth(child.id, 1)).rejects.toThrow("Subagent depth limit reached (1)")
      await expect(assertSubagentDepth(child.id, 2)).resolves.toBeUndefined()
    },
  })
})
