import { Instance } from "@/project/instance"
import { Plugin } from "../plugin"
import { map, filter, pipe, fromEntries, mapValues } from "remeda"
import z from "zod"
import { fn } from "@/util/fn"
import type { AuthOuathResult, Hooks } from "@opencode-ai/plugin"
import { NamedError } from "@opencode-ai/util/error"
import { Auth } from "@/auth"

export namespace ProviderAuth {
  const state = Instance.state(async () => {
    const methods = pipe(
      await Plugin.list(),
      filter((x) => x.auth?.provider !== undefined),
      map((x) => [x.auth!.provider, x.auth!] as const),
      fromEntries(),
    )
    return {
      methods,
      pending: {} as Record<
        string,
        {
          providerID: string
          method: number
          result: AuthOuathResult
        }
      >,
      latest: {} as Record<string, string>,
    }
  })

  export const Method = z
    .object({
      type: z.union([z.literal("oauth"), z.literal("api")]),
      label: z.string(),
    })
    .meta({
      ref: "ProviderAuthMethod",
    })
  export type Method = z.infer<typeof Method>

  export async function methods() {
    const s = await state().then((x) => x.methods)
    return mapValues(s, (x) =>
      x.methods.map(
        (y): Method => ({
          type: y.type,
          label: y.label,
        }),
      ),
    )
  }

  export const Authorization = z
    .object({
      url: z.string(),
      method: z.union([z.literal("auto"), z.literal("code")]),
      instructions: z.string(),
      flow: z.string(),
    })
    .meta({
      ref: "ProviderAuthAuthorization",
    })
  export type Authorization = z.infer<typeof Authorization>

  export const authorize = fn(
    z.object({
      providerID: z.string(),
      method: z.number(),
    }),
    async (input): Promise<Authorization | undefined> => {
      const auth = await state().then((s) => s.methods[input.providerID])
      const method = auth.methods[input.method]
      if (method.type === "oauth") {
        const result = await method.authorize()
        const flow = crypto.randomUUID()
        await state().then((s) => {
          s.pending[flow] = {
            providerID: input.providerID,
            method: input.method,
            result,
          }
          s.latest[input.providerID] = flow
        })
        return {
          url: result.url,
          method: result.method,
          instructions: result.instructions,
          flow,
        }
      }
    },
  )

  export const callback = fn(
    z.object({
      providerID: z.string(),
      method: z.number(),
      code: z.string().optional(),
      flow: z.string().optional(),
    }),
    async (input) => {
      const s = await state()
      const flow = input.flow ?? s.latest[input.providerID]
      const pending = flow ? s.pending[flow] : undefined
      if (!pending || pending.providerID !== input.providerID || pending.method !== input.method) {
        throw new OauthMissing({ providerID: input.providerID })
      }
      const match = pending.result
      try {
        let result

        if (match.method === "code") {
          if (!input.code) throw new OauthCodeMissing({ providerID: input.providerID })
          result = await match.callback(input.code)
        }

        if (match.method === "auto") {
          result = await match.callback()
        }

        if (result?.type === "success") {
          if ("key" in result) {
            await Auth.set(input.providerID, {
              type: "api",
              key: result.key,
            })
          }
          if ("refresh" in result) {
            const info: Auth.Info = {
              type: "oauth",
              access: result.access,
              refresh: result.refresh,
              expires: result.expires,
            }
            if (result.accountId) {
              info.accountId = result.accountId
            }
            if (result.email) {
              info.email = result.email
            }
            if (input.providerID === "openai") await Auth.add(input.providerID, info)
            if (input.providerID !== "openai") await Auth.set(input.providerID, info)
          }
          return
        }

        throw new OauthCallbackFailed({})
      } finally {
        if (flow) delete s.pending[flow]
        if (s.latest[input.providerID] === flow) delete s.latest[input.providerID]
      }
    },
  )

  export const api = fn(
    z.object({
      providerID: z.string(),
      key: z.string(),
    }),
    async (input) => {
      await Auth.set(input.providerID, {
        type: "api",
        key: input.key,
      })
    },
  )

  export const OauthMissing = NamedError.create(
    "ProviderAuthOauthMissing",
    z.object({
      providerID: z.string(),
    }),
  )
  export const OauthCodeMissing = NamedError.create(
    "ProviderAuthOauthCodeMissing",
    z.object({
      providerID: z.string(),
    }),
  )

  export const OauthCallbackFailed = NamedError.create("ProviderAuthOauthCallbackFailed", z.object({}))
}
