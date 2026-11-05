export const keys = {
  account: (id: string) => ({ me: () => ["account", id, "me"] }),
  org: (id: string) => ({ all: ["org", id], agents: () => ["org", id, "agents"] }),
};
export const keyOf = (s: string) => ["deployment", s];
