// Violations of the org filter rule; each marked line must be reported, nothing else.
declare const db: any;
declare const sql: any;

export async function leaks(orgId: string, id: string) {
  await db.selectFrom("things").selectAll().where("id", "=", id); // expect: org-filter
  await db.updateTable("things as t").set({ id }).where("t.id", "=", id); // expect: org-filter
  await db.deleteFrom("capybara.notes").where("thing_id", "=", id); // expect: org-filter
  await db.selectFrom(["notes", "orgs"]).selectAll(); // expect: org-filter
  // selecting org_id is not filtering by it
  await db.selectFrom("things").select(["id", "org_id"]).where("id", "=", id); // expect: org-filter
  // owner_org_id is not org_id
  await db.selectFrom("things").selectAll().where("owner_org_id", "=", orgId); // expect: org-filter
  await sql`SELECT id FROM capybara.things WHERE id = ${id}`.execute(db); // expect: org-filter
  let q = db.selectFrom("notes").selectAll(); // expect: org-filter
  q = q.where("id", "=", id);
  await q.execute();
}

export async function exemptions(id: string) {
  // org-filter: ok
  await db.selectFrom("things").selectAll().where("id", "=", id); // expect-above: org-filter-reason
  // org-filter: this marker covers a query that filters already, so it is stale
  await db.selectFrom("things").selectAll().where("org_id", "=", id); // expect-above: org-filter-stale
  await db
    .selectFrom("notes") // expect: org-filter
    .selectAll()
    .where((eb: any) =>
      // org-filter: a marker above a nested expression covers nothing, it is stale
      eb("id", "=", id), // expect-above: org-filter-stale
    );
}

declare function asPlatform<T>(reason: string, fn: () => T): T;

export async function sweepOutsidePlatform() {
  // org-filter: deployment-wide sweep across every org, but not in the platform scope
  await db.selectFrom("things").select(["id", "org_id"]).execute(); // expect: org-filter-platform
  // org-filter: deployment-wide sweep; asPlatform runs after the query, not around it
  await db.selectFrom("notes").selectAll().execute(); // expect: org-filter-platform
  await asPlatform("later", async () => {});
}
