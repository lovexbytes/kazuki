import {afterAll, expect, test} from "bun:test"
import * as fs from "node:fs"

process.env.KAZUKI_DIR = fs.mkdtempSync("/tmp/cloud-test-")
const {Cloud, LOCAL} = await import("../src/core/cloud.ts")

function cloud_new() {
  fs.rmSync(process.env.KAZUKI_DIR ?? "", {recursive: true, force: true})
  fs.mkdirSync(process.env.KAZUKI_DIR ?? "", {recursive: true})
  return Cloud.open(() => {})
}

afterAll(() =>
  fs.rmSync(process.env.KAZUKI_DIR ?? "", {recursive: true, force: true})
)

test("Cloud always resolves the stable local user", () => {
  const cloud = cloud_new()
  const req = new Request("http://127.0.0.1/api/me", {
    headers: {authorization: "Bearer ignored", cookie: "kazuki=ignored"}
  })
  expect(Cloud.who(cloud, req)).toEqual(LOCAL)
  expect(Cloud.user(cloud, "local")).toEqual(LOCAL)
  expect(Cloud.user(cloud, "1")).toBeNull()
})

test("Cloud creates only local tables and clears local records", async () => {
  const cloud = cloud_new()
  const tables = cloud.db
    .query("select name from sqlite_master where type = 'table' order by name")
    .all() as {name: string}[]
  expect(tables.map(({name}) => name)).toEqual(["acts"])
  cloud.db
    .query("insert into acts values (?, ?, ?, ?)")
    .run("local", "1", "{}", 0)
  cloud.db
    .query("insert into acts values (?, ?, ?, ?)")
    .run("old", "1", "{}", 0)
  Cloud.close(cloud, LOCAL)
  expect(cloud.db.query("select user from acts order by user").all()).toEqual([
    {user: "old"}
  ])
})

test("/api/me needs no authorization and login routes are absent", async () => {
  const cloud = cloud_new()
  const me = await Cloud.http(cloud, new Request("http://127.0.0.1/api/me"))
  expect(me?.status).toBe(200)
  expect(await me?.json()).toEqual({id: "local", name: "local"})
  expect(
    await Cloud.http(
      cloud,
      new Request("http://127.0.0.1/api/login", {method: "POST"})
    )
  ).toBeNull()
  expect(
    await Cloud.http(cloud, new Request("http://127.0.0.1/auth"))
  ).toBeNull()
})
