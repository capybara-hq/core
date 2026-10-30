@Injectable()
export class EventLog {}

export const twice = () => new EventLog(); // expect: kc-wiring
export const other = () => new MetricsService(); // expect: kc-wiring
