-- Internal endpoints a super admin lets one org's extension requests reach (plugin safe fetch spec):
-- `ctx.net.fetch` made for the org may connect to a private address only when the target matches
-- one of these entries. `entry` is a hostname, a `*.domain` wildcard, an IP, a CIDR, or an origin
-- `http(s)://host:port` (validated and normalized by the kernel, `orgs/network-allowances.service.ts`).
CREATE TABLE IF NOT EXISTS org_network_allowances (
  id uuid PRIMARY KEY,
  org_id text NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  entry text NOT NULL,
  created_by text REFERENCES accounts(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, entry)
);
