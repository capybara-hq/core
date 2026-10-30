export class ModelListCache {} // expect: kc-cache

export class Providers {
  async models(p: string): Promise<string[]> {
    const key = modelsKey(p);
    const hit = await this.kv.get(key);
    if (hit) return JSON.parse(hit);
    const models = await this.fetch(p);
    await this.kv.set(key, JSON.stringify(models), "EX", 600); // expect: kc-cache
    return models;
  }

  async dedupe(key: string): Promise<boolean> {
    if ((await this.redis.get(key)) === DONE) return false;
    await this.redis.set(key, "pending", "EX", 60);
    await this.redis.set(key, DONE, "EX", 600);
    return true;
  }

  async mark(id: string): Promise<void> {
    await this.redis.set(markKey(id), "1", "EX", 60);
  }
}
