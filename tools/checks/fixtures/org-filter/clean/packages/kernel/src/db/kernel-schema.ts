interface OrgScoped {
  org_id: string;
}
export interface ThingsTable extends OrgScoped {
  id: string;
  parent_id: string | null;
}
export interface NotesTable {
  id: string;
  org_id: string | null;
  thing_id: string;
}
export interface OrgsTable {
  id: string;
  owner_org_id: string | null;
}
export interface KernelDatabase {
  things: ThingsTable;
  notes: NotesTable;
  orgs: OrgsTable;
}
