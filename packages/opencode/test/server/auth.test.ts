import { expect, test } from "bun:test"

import { Auth } from "../../src/auth"
import { Server } from "../../src/server/server"

test("auth account endpoints list metadata, select, and remove", async () => {
  const provider = "test-auth-routes"
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
  const app = Server.App()

  const list = await app.request(`/auth/${provider}/accounts`)
  expect(list.status).toBe(200)
  const accounts = (await list.json()) as Auth.Summary[]
  expect(accounts).toEqual([
    { id: first, email: "one@example.com", active: false },
    { id: second, email: "two@example.com", active: true },
  ])
  expect(JSON.stringify(accounts)).not.toContain("access-2")
  expect(JSON.stringify(accounts)).not.toContain("refresh-2")

  const select = await app.request(`/auth/${provider}/accounts/${first}`, { method: "PATCH" })
  expect(select.status).toBe(200)
  expect(await select.json()).toBe(true)
  expect((await Auth.account(provider))?.id).toBe(first)

  const remove = await app.request(`/auth/${provider}/accounts/${first}`, { method: "DELETE" })
  expect(remove.status).toBe(200)
  expect(await remove.json()).toBe(true)
  expect((await Auth.accounts(provider))[0]?.id).toBe(second)

  const missing = await app.request(`/auth/${provider}/accounts/${first}`, { method: "PATCH" })
  expect(missing.status).toBe(404)
  await Auth.remove(provider)
})
