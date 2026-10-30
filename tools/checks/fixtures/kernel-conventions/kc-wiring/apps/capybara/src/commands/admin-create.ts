import { AccountsService, EventLog } from "@capybara-hq/kernel";

export async function adminCreate(): Promise<void> {
  const accounts = new AccountsService({}); // expect: kc-wiring
  void new EventLog(); // expect: kc-wiring
  void new Map();
  void accounts;
}
