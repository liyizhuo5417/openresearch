import { mkdir, open, rename, rmdir, stat, unlink } from "node:fs/promises"
import path from "node:path"

import z from "zod"

import { Global } from "../global"
import { Filesystem } from "../util/filesystem"
import { Lock } from "../util/lock"

export const OAUTH_DUMMY_KEY = "opencode-oauth-dummy-key"

export namespace Auth {
  export const Oauth = z
    .object({
      type: z.literal("oauth"),
      refresh: z.string(),
      access: z.string(),
      expires: z.number(),
      accountId: z.string().optional(),
      email: z.string().optional(),
      enterpriseUrl: z.string().optional(),
    })
    .meta({ ref: "OAuth" })

  export const Api = z
    .object({
      type: z.literal("api"),
      key: z.string(),
    })
    .meta({ ref: "ApiAuth" })

  export const WellKnown = z
    .object({
      type: z.literal("wellknown"),
      key: z.string(),
      token: z.string(),
    })
    .meta({ ref: "WellKnownAuth" })

  export const Info = z.discriminatedUnion("type", [Oauth, Api, WellKnown]).meta({ ref: "Auth" })
  export type Info = z.infer<typeof Info>

  const Account = Oauth.extend({ id: z.string() })
  type Account = z.infer<typeof Account>

  const Group = z.object({
    type: z.literal("oauth-accounts"),
    active: z.string(),
    accounts: z.array(Account),
  })
  type Group = z.infer<typeof Group>

  export const Summary = z
    .object({
      id: z.string(),
      email: z.string().optional(),
      active: z.boolean(),
    })
    .meta({ ref: "AuthAccount" })
  export type Summary = z.infer<typeof Summary>

  const filepath = path.join(Global.Path.data, "auth.json")
  const accountpath = path.join(Global.Path.data, "auth-accounts.json")
  const lockpath = path.join(Global.Path.data, "auth.lock")

  function missing(error: unknown) {
    return (error as { code?: string }).code === "ENOENT"
  }

  async function load(): Promise<Record<string, Info>> {
    const data = await Filesystem.readJson<Record<string, unknown>>(filepath).catch((error: unknown) => {
      if (missing(error)) return {}
      throw error
    })
    return Object.entries(data).reduce(
      (acc, [key, value]) => {
        const parsed = Info.safeParse(value)
        if (!parsed.success) return acc
        acc[key] = parsed.data
        return acc
      },
      {} as Record<string, Info>,
    )
  }

  async function loadAccounts(): Promise<Record<string, Group>> {
    const data = await Filesystem.readJson<Record<string, unknown>>(accountpath).catch((error: unknown) => {
      if (missing(error)) return {}
      throw error
    })
    return Object.entries(data).reduce(
      (acc, [key, value]) => {
        const parsed = Group.safeParse(value)
        if (!parsed.success) return acc
        acc[key] = parsed.data
        return acc
      },
      {} as Record<string, Group>,
    )
  }

  function group(info: z.infer<typeof Oauth>): Group {
    const id = crypto.randomUUID()
    return {
      type: "oauth-accounts",
      active: id,
      accounts: [{ id, ...info }],
    }
  }

  function info(account: Account) {
    const { id: _, ...result } = account
    return result
  }

  function match(value: Group, auth: z.infer<typeof Oauth>) {
    const token = value.accounts.find((item) => item.refresh === auth.refresh)
    if (token) return token
    if (!auth.accountId || !auth.email) return
    const accounts = value.accounts.filter((item) => item.accountId === auth.accountId)
    const email = auth.email.toLowerCase()
    const account = accounts.find((item) => item.email?.toLowerCase() === email)
    if (account) return account
    if (accounts.length === 1 && !accounts[0].email) return accounts[0]
    return
  }

  function same(account: Account | undefined, auth: z.infer<typeof Oauth>) {
    return (
      account?.refresh === auth.refresh &&
      account.access === auth.access &&
      account.expires === auth.expires &&
      account.accountId === auth.accountId &&
      account.email === auth.email &&
      account.enterpriseUrl === auth.enterpriseUrl
    )
  }

  function sync(value: Group, auth: z.infer<typeof Oauth>) {
    const active = value.accounts.find((item) => item.id === value.active)
    if (same(active, auth)) return false
    if (active?.refresh === auth.refresh) {
      const index = value.accounts.indexOf(active)
      value.accounts[index] = { id: active.id, email: active.email, ...auth }
      return true
    }
    const account = match(value, auth)
    if (account) {
      const index = value.accounts.indexOf(account)
      value.accounts[index] = { id: account.id, email: account.email, ...auth }
      value.active = account.id
      return true
    }
    const id = crypto.randomUUID()
    value.accounts.push({ id, ...auth })
    value.active = id
    return true
  }

  async function save(file: string, data: unknown) {
    const temp = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`
    await Filesystem.writeJson(temp, data, 0o600)
    await rename(temp, file)
  }

  async function locked<T>(fn: () => Promise<T>, file = lockpath) {
    using _ = await Lock.write(file)
    await mkdir(path.dirname(file), { recursive: true })
    while (true) {
      const handle = await open(file, "wx", 0o600).catch((error: unknown) => {
        if ((error as { code?: string }).code === "EEXIST") return
        throw error
      })
      if (handle) {
        await handle.close()
        try {
          return await fn()
        } finally {
          await unlink(file).catch(() => {})
        }
      }
      const expired = await stat(file)
        .then((value) => Date.now() - value.mtimeMs > 5 * 60_000)
        .catch(() => false)
      const breaker = `${file}.breaker`
      const acquired = expired
        ? await mkdir(breaker).then(
            () => true,
            (error: unknown) => {
              if ((error as { code?: string }).code === "EEXIST") return false
              throw error
            },
          )
        : false
      if (acquired) {
        const stale = await stat(file)
          .then((value) => Date.now() - value.mtimeMs > 5 * 60_000)
          .catch(() => false)
        if (stale) await unlink(file).catch(() => {})
        await rmdir(breaker).catch(() => {})
      }
      await Bun.sleep(25)
    }
  }

  export async function get(providerID: string) {
    const auth = await all()
    return auth[providerID]
  }

  export async function all(): Promise<Record<string, Info>> {
    return load()
  }

  export async function set(key: string, info: Info) {
    const normalized = key.replace(/\/+$/, "")
    await locked(async () => {
      const data = await load()
      const groups = await loadAccounts()
      if (normalized !== key) {
        delete data[key]
        delete groups[key]
      }
      delete data[normalized + "/"]
      delete groups[normalized + "/"]
      const value = groups[normalized]
      if (value && info.type === "oauth") {
        const index = value.accounts.findIndex((item) => item.id === value.active)
        if (index !== -1) {
          const before = value.accounts[index]
          value.accounts[index] = { id: before.id, email: before.email, ...info }
          await save(accountpath, groups)
        }
      }
      if (info.type !== "oauth") {
        delete groups[normalized]
        await save(accountpath, groups)
      }
      data[normalized] = info
      await save(filepath, data)
    })
  }

  export async function remove(key: string) {
    const normalized = key.replace(/\/+$/, "")
    await locked(async () => {
      const data = await load()
      const groups = await loadAccounts()
      delete data[key]
      delete data[normalized]
      delete groups[key]
      delete groups[normalized]
      await save(accountpath, groups)
      await save(filepath, data)
    })
  }

  export async function add(key: string, info: z.infer<typeof Oauth>) {
    const normalized = key.replace(/\/+$/, "")
    return locked(async () => {
      const data = await load()
      const groups = await loadAccounts()
      if (normalized !== key) {
        delete data[key]
        delete groups[key]
      }
      delete data[normalized + "/"]
      delete groups[normalized + "/"]
      const before = data[normalized]
      const value = groups[normalized] ?? (before?.type === "oauth" ? group(before) : group(info))
      sync(value, info)
      groups[normalized] = value
      data[normalized] = info
      if (!before) await save(filepath, data)
      await save(accountpath, groups)
      if (before) await save(filepath, data)
      return value.active
    })
  }

  export async function accounts(key: string): Promise<Summary[]> {
    const normalized = key.replace(/\/+$/, "")
    return locked(async () => {
      const data = await load()
      const groups = await loadAccounts()
      const auth = data[normalized]
      if (auth?.type !== "oauth") {
        if (groups[normalized]) {
          delete groups[normalized]
          await save(accountpath, groups)
        }
        return []
      }
      const before = groups[normalized]
      const value = before ?? group(auth)
      const changed = !before || sync(value, auth)
      groups[normalized] = value
      if (changed) await save(accountpath, groups)
      return value.accounts.map((item) => ({
        id: item.id,
        email: item.email,
        active: item.id === value.active,
      }))
    })
  }

  export async function account(key: string, id?: string): Promise<Account | undefined> {
    const normalized = key.replace(/\/+$/, "")
    const [data, groups] = await Promise.all([load(), loadAccounts()])
    const auth = data[normalized]
    const stored = groups[normalized]
    const active = stored?.accounts.find((item) => item.id === stored.active)
    if (auth?.type === "oauth" && stored && same(active, auth)) {
      return stored.accounts.find((item) => item.id === (id ?? stored.active))
    }
    return locked(async () => {
      const data = await load()
      const groups = await loadAccounts()
      const auth = data[normalized]
      if (auth?.type !== "oauth") return
      const before = groups[normalized]
      const value = before ?? group(auth)
      const changed = !before || sync(value, auth)
      groups[normalized] = value
      if (changed) await save(accountpath, groups)
      return value.accounts.find((item) => item.id === (id ?? value.active))
    })
  }

  export async function update(key: string, id: string, info: z.infer<typeof Oauth>) {
    const normalized = key.replace(/\/+$/, "")
    return locked(async () => {
      const data = await load()
      const groups = await loadAccounts()
      const value = groups[normalized]
      if (!value) return false
      const index = value.accounts.findIndex((item) => item.id === id)
      if (index === -1) return false
      const before = value.accounts[index]
      value.accounts[index] = { id, email: before.email, ...info }
      if (value.active === id) data[normalized] = info
      await save(accountpath, groups)
      await save(filepath, data)
      return true
    })
  }

  export async function select(key: string, id: string) {
    const normalized = key.replace(/\/+$/, "")
    return locked(async () => {
      const data = await load()
      const groups = await loadAccounts()
      const value = groups[normalized]
      const account = value?.accounts.find((item) => item.id === id)
      if (!value || !account) return false
      value.active = id
      data[normalized] = info(account)
      await save(accountpath, groups)
      await save(filepath, data)
      return true
    })
  }

  export async function removeAccount(key: string, id: string) {
    const normalized = key.replace(/\/+$/, "")
    return locked(async () => {
      const data = await load()
      const groups = await loadAccounts()
      const value = groups[normalized]
      if (!value) return false
      const accounts = value.accounts.filter((item) => item.id !== id)
      if (accounts.length === value.accounts.length) return false
      if (accounts.length === 0) {
        delete data[normalized]
        delete groups[normalized]
      }
      if (accounts.length > 0) {
        value.accounts = accounts
        if (value.active === id) value.active = accounts[0].id
        data[normalized] = info(value.accounts.find((item) => item.id === value.active)!)
      }
      await save(accountpath, groups)
      await save(filepath, data)
      return true
    })
  }

  export async function refresh<T>(id: string, fn: () => Promise<T>) {
    return locked(fn, path.join(Global.Path.data, `auth-refresh-${id}.lock`))
  }
}
