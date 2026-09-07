import path from "path"

import { test, expect } from "bun:test"

import { Auth } from "../../src/auth"
import { Global } from "../../src/global"
import { Filesystem } from "../../src/util/filesystem"

test("set normalizes trailing slashes in keys", async () => {
  await Auth.set("https://example.com/", {
    type: "wellknown",
    key: "TOKEN",
    token: "abc",
  })
  const data = await Auth.all()
  expect(data["https://example.com"]).toBeDefined()
  expect(data["https://example.com/"]).toBeUndefined()
})

test("set cleans up pre-existing trailing-slash entry", async () => {
  // Simulate a pre-fix entry with trailing slash
  await Auth.set("https://example.com/", {
    type: "wellknown",
    key: "TOKEN",
    token: "old",
  })
  // Re-login with normalized key (as the CLI does post-fix)
  await Auth.set("https://example.com", {
    type: "wellknown",
    key: "TOKEN",
    token: "new",
  })
  const data = await Auth.all()
  const keys = Object.keys(data).filter((k) => k.includes("example.com"))
  expect(keys).toEqual(["https://example.com"])
  const entry = data["https://example.com"]!
  expect(entry.type).toBe("wellknown")
  if (entry.type === "wellknown") expect(entry.token).toBe("new")
})

test("remove deletes both trailing-slash and normalized keys", async () => {
  await Auth.set("https://example.com", {
    type: "wellknown",
    key: "TOKEN",
    token: "abc",
  })
  await Auth.remove("https://example.com/")
  const data = await Auth.all()
  expect(data["https://example.com"]).toBeUndefined()
  expect(data["https://example.com/"]).toBeUndefined()
})

test("set and remove are no-ops on keys without trailing slashes", async () => {
  await Auth.set("anthropic", {
    type: "api",
    key: "sk-test",
  })
  const data = await Auth.all()
  expect(data["anthropic"]).toBeDefined()
  await Auth.remove("anthropic")
  const after = await Auth.all()
  expect(after["anthropic"]).toBeUndefined()
})

test("accounts migrates an existing oauth credential", async () => {
  const provider = "test-oauth-migration"
  await Auth.set(provider, {
    type: "oauth",
    refresh: "refresh-1",
    access: "access-1",
    expires: 1,
    accountId: "account-1",
    email: "one@example.com",
  })

  const accounts = await Auth.accounts(provider)
  expect(accounts).toHaveLength(1)
  expect(accounts[0]).toMatchObject({ email: "one@example.com", active: true })
  expect((await Auth.get(provider))?.type).toBe("oauth")
  const data = await Filesystem.readJson<Record<string, unknown>>(path.join(Global.Path.data, "auth.json"))
  expect(data[provider]).toMatchObject({ type: "oauth", refresh: "refresh-1" })
  expect(data[provider]).not.toHaveProperty("accounts")
  await Auth.remove(provider)
})

test("oauth accounts can be added and selected", async () => {
  const provider = "test-oauth-select"
  const first = await Auth.add(provider, {
    type: "oauth",
    refresh: "refresh-1",
    access: "access-1",
    expires: 1,
    accountId: "account-1",
    email: "one@example.com",
  })
  const second = await Auth.add(provider, {
    type: "oauth",
    refresh: "refresh-2",
    access: "access-2",
    expires: 2,
    accountId: "account-2",
    email: "two@example.com",
  })

  expect(((await Auth.get(provider)) as { access: string }).access).toBe("access-2")
  expect(await Auth.select(provider, first)).toBe(true)
  expect(((await Auth.get(provider)) as { access: string }).access).toBe("access-1")
  expect((await Auth.accounts(provider)).find((item) => item.id === second)?.active).toBe(false)
  await Auth.remove(provider)
})

test("adding the same oauth account updates it instead of duplicating it", async () => {
  const provider = "test-oauth-deduplicate"
  const first = await Auth.add(provider, {
    type: "oauth",
    refresh: "refresh-1",
    access: "access-1",
    expires: 1,
    accountId: "account-1",
    email: "one@example.com",
  })
  const second = await Auth.add(provider, {
    type: "oauth",
    refresh: "refresh-2",
    access: "access-2",
    expires: 2,
    accountId: "account-1",
    email: "one@example.com",
  })

  expect(second).toBe(first)
  expect(await Auth.accounts(provider)).toHaveLength(1)
  expect(((await Auth.get(provider)) as { access: string }).access).toBe("access-2")
  await Auth.remove(provider)
})

test("oauth users in the same workspace remain separate accounts", async () => {
  const provider = "test-oauth-workspace"
  await Auth.add(provider, {
    type: "oauth",
    refresh: "refresh-1",
    access: "access-1",
    expires: 1,
    accountId: "workspace-1",
    email: "one@example.com",
  })
  await Auth.add(provider, {
    type: "oauth",
    refresh: "refresh-2",
    access: "access-2",
    expires: 2,
    accountId: "workspace-1",
    email: "two@example.com",
  })

  expect(await Auth.accounts(provider)).toHaveLength(2)
  await Auth.remove(provider)
})

test("missing email does not overwrite an account in a shared workspace", async () => {
  const provider = "test-oauth-missing-email"
  await Auth.add(provider, {
    type: "oauth",
    refresh: "refresh-1",
    access: "access-1",
    expires: 1,
    accountId: "workspace-1",
    email: "one@example.com",
  })
  await Auth.add(provider, {
    type: "oauth",
    refresh: "refresh-2",
    access: "access-2",
    expires: 2,
    accountId: "workspace-1",
  })

  expect(await Auth.accounts(provider)).toHaveLength(2)
  expect((await Auth.account(provider))?.access).toBe("access-2")
  await Auth.remove(provider)
})

test("update and remove target a specific oauth account", async () => {
  const provider = "test-oauth-update"
  const first = await Auth.add(provider, {
    type: "oauth",
    refresh: "refresh-1",
    access: "access-1",
    expires: 1,
    accountId: "account-1",
    email: "one@example.com",
  })
  const second = await Auth.add(provider, {
    type: "oauth",
    refresh: "refresh-2",
    access: "access-2",
    expires: 2,
    accountId: "account-2",
    email: "two@example.com",
  })

  expect(
    await Auth.update(provider, first, {
      type: "oauth",
      refresh: "refresh-3",
      access: "access-3",
      expires: 3,
      accountId: "account-1",
    }),
  ).toBe(true)
  expect((await Auth.account(provider, first))?.access).toBe("access-3")
  expect((await Auth.account(provider, first))?.email).toBe("one@example.com")
  expect((await Auth.account(provider, second))?.access).toBe("access-2")

  expect(await Auth.removeAccount(provider, second)).toBe(true)
  expect((await Auth.accounts(provider))[0]?.id).toBe(first)
  expect((await Auth.accounts(provider))[0]?.active).toBe(true)
  expect(await Auth.removeAccount(provider, first)).toBe(true)
  expect(await Auth.get(provider)).toBeUndefined()
})
