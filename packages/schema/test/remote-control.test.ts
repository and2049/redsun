import { expect, test } from "bun:test"
import { Schema } from "effect"
import { RemoteControl } from "../src/remote-control.js"

test("remote settings preserve optional origin and bounded integer port", () => {
  const decode = Schema.decodeUnknownSync(RemoteControl.Settings)
  const encode = Schema.encodeSync(RemoteControl.Settings)
  expect(encode(decode({ enabled: true, origin: "https://fixture.ts.net", port: 43123 }))).toEqual({
    enabled: true,
    origin: "https://fixture.ts.net",
    port: 43123,
  })
  expect(encode({ origin: undefined, port: undefined })).toEqual({})
  for (const port of [1, 65535]) expect(decode({ port }).port).toBe(port)
  for (const port of [0, 65536, 1.5, "43123"]) expect(() => decode({ port })).toThrow()
  expect(RemoteControl.Status.fields).not.toHaveProperty("origin")
  expect(RemoteControl.Status.fields).not.toHaveProperty("port")
})
