// A clean tree: every query on an org-scoped table filters by org_id or says why it need not.
declare const db: any;
declare const sql: any;
declare function Injectable(): ClassDecorator;

export async function byOrg(orgId: string, id: string) {
  await db.selectFrom("things").selectAll().where("org_id", "=", orgId).where("id", "=", id);
  await db.updateTable("things as t").set({ id }).where("t.org_id", "=", orgId);
  await db.deleteFrom("notes").where((eb: any) => eb.and([eb("org_id", "=", orgId)]));
  // a table without org_id is not checked
  await db.selectFrom("orgs").selectAll().where("id", "=", id);
  // a subquery on an org-scoped table that filters covers the outer query (join through it)
  await db
    .selectFrom("notes")
    .selectAll()
    .where("thing_id", "in", db.selectFrom("things").select("id").where("org_id", "=", orgId));
  // a join whose condition carries org_id
  await db
    .selectFrom("notes as n")
    .innerJoin("things as t", (j: any) => j.onRef("t.org_id", "=", "n.org_id"))
    .selectAll();
  // built in a variable and filtered later in the same function
  let q = db.selectFrom("things").selectAll();
  q = q.where("org_id", "=", orgId);
  await q.execute();
  await sql`SELECT id FROM capybara.things WHERE org_id = ${orgId}`.execute(db);
  // inserts write the row's own org and are not checked
  await db.insertInto("things").values({ id, org_id: orgId });
}

export async function sweep() {
  // org-filter: deployment-wide sweep across every org, each row handled in its own org
  await db.selectFrom("things").select(["id", "org_id"]).execute();
}

@Injectable()
// org-filter: super-admin service (platform guard on every route), reads every org on purpose
export class PlatformThings {
  async all() {
    return db.selectFrom("things").selectAll().execute();
  }
}

// org-filter: kernel job service; every id comes from a job payload the kernel wrote
@Injectable()
export class ThingJobs {
  async one(id: string) {
    return db.selectFrom("notes").selectAll().where("id", "=", id).execute();
  }
}
