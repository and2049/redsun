import { BusEvent } from "@/bus/bus-event"
import { Bus } from "@/bus"
import z from "zod"
import { Storage } from "../storage/storage"
import { Identifier } from "../id/id"

export namespace Entry {
  export const CustomEntry = z
    .object({
      id: z.string(),
      sessionID: z.string(),
      type: z.literal("custom"),
      customType: z.string(),
      data: z.unknown().optional(),
      timestamp: z.number(),
    })
    .meta({ ref: "CustomEntry" })
  export type CustomEntry = z.infer<typeof CustomEntry>

  export const CustomMessageEntry = z
    .object({
      id: z.string(),
      sessionID: z.string(),
      type: z.literal("custom_message"),
      customType: z.string(),
      content: z.union([
        z.string(),
        z.array(z.object({ type: z.literal("text"), text: z.string() })),
      ]),
      display: z.boolean(),
      details: z.unknown().optional(),
      timestamp: z.number(),
    })
    .meta({ ref: "CustomMessageEntry" })
  export type CustomMessageEntry = z.infer<typeof CustomMessageEntry>

  export const Info = z
    .discriminatedUnion("type", [CustomEntry, CustomMessageEntry])
    .meta({ ref: "Entry" })
  export type Info = z.infer<typeof Info>

  export const Event = {
    Appended: BusEvent.define(
      "entry.appended",
      z.object({
        sessionID: z.string(),
        entryID: z.string(),
        customType: z.string(),
        type: z.enum(["custom", "custom_message"]),
      }),
    ),
  }

  export async function append(sessionID: string, input: Omit<CustomEntry, "id" | "sessionID" | "timestamp">): Promise<string>
  export async function append(sessionID: string, input: Omit<CustomMessageEntry, "id" | "sessionID" | "timestamp">): Promise<string>
  export async function append(sessionID: string, input: Omit<Info, "id" | "sessionID" | "timestamp">): Promise<string> {
    const id = Identifier.ascending("entry")
    const entry = {
      ...input,
      id,
      sessionID,
      timestamp: Date.now(),
    } as Info
    await Storage.write(["entry", sessionID, id], entry)
    Bus.publish(Event.Appended, {
      sessionID,
      entryID: id,
      customType: input.customType,
      type: input.type,
    })
    return id
  }

  export async function list(sessionID: string): Promise<Info[]> {
    const result: Info[] = []
    for (const key of await Storage.list(["entry", sessionID])) {
      const entry = await Storage.read<Info>(key)
      result.push(entry)
    }
    result.sort((a, b) => a.timestamp - b.timestamp)
    return result
  }

  export async function getByType<T = unknown>(
    sessionID: string,
    customType: string,
  ): Promise<Array<{ customType: string; data?: T; details?: T }>> {
    const all = await list(sessionID)
    return all
      .filter((e) => e.customType === customType)
      .map((e) => {
        if (e.type === "custom") return { customType: e.customType, data: e.data as T | undefined }
        return { customType: e.customType, details: e.details as T | undefined }
      })
  }

  export async function remove(sessionID: string, entryID: string): Promise<void> {
    await Storage.remove(["entry", sessionID, entryID])
  }

  export async function removeAll(sessionID: string): Promise<void> {
    for (const key of await Storage.list(["entry", sessionID])) {
      await Storage.remove(key)
    }
  }
}
